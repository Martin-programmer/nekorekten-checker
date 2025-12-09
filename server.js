// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Парсваме JSON от Shopify webhook-а
app.use(express.json());

// Помощна функция: нормализиране на български телефон в формат 359...
function normalizePhoneTo359(phoneRaw) {
  if (!phoneRaw) return '';
  let p = String(phoneRaw).replace(/[^\d]/g, '');

  if (p.startsWith('00')) {
    p = p.slice(2);
  }
  if (p.startsWith('359')) {
    return p;
  }
  if (p.startsWith('0')) {
    return '359' + p.slice(1);
  }
  return p;
}


// 1) Проверка в Nekorekten по име/телефон/имейл
async function checkCustomerInNekorekten(phone) {
  if (!phone) {
    console.log('Nekorekten: няма телефон → пропускаме проверка.');
    return { hasReports: false, raw: null };
  }

  try {
    const resp = await axios.get('https://api.nekorekten.com/api/v1/reports', {
      headers: {
        'Api-Key': process.env.NEKOREKTEN_API_KEY,
      },
      params: {
        phone: phone,
        searchMode: 'all', // не е критично, но го оставяме
      },
    });

    const data = resp.data;

    // Тук е важното: Nekorekten връща { items: [...], count: N, ... }
    let hasReports = false;

    if (Array.isArray(data)) {
      // Ако някой ден върнат чист масив
      hasReports = data.length > 0;
    } else if (Array.isArray(data.items)) {
      // Нормалният случай – гледаме items
      hasReports = data.items.length > 0;
    } else if (typeof data.count === 'number') {
      // Допълнителна защита – ако има count > 0
      hasReports = data.count > 0;
    }

    console.log(
      'Nekorekten result summary:',
      'count =',
      data.count,
      'items length =',
      Array.isArray(data.items) ? data.items.length : 'n/a'
    );
    console.log('Nekorekten raw:', JSON.stringify(data));

    return { hasReports, raw: data };

  } catch (err) {
    console.error(
      'Грешка при заявка към Nekorekten:',
      err.response?.status,
      err.response?.data || err.message
    );
    return { hasReports: false, error: err };
  }
}


// 2) Добавяне на tag "nekorekten-flagged" към поръчката в Shopify
async function addFlagTagToOrder(order) {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!storeDomain || !token) {
    console.error('SHOPIFY_STORE_DOMAIN или SHOPIFY_ADMIN_TOKEN липсват в .env');
    return;
  }

  const orderId = order.id;

  // В webhook payload-а има поле "tags" като string
  const existingTagsStr = order.tags || '';
  const tagsArr = existingTagsStr
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (!tagsArr.includes('nekorekten-flagged')) {
    tagsArr.push('nekorekten-flagged');
  }

  const newTagsStr = tagsArr.join(', ');

  try {
    const apiVersion = '2025-10'; // актуална REST версия към момента :contentReference[oaicite:5]{index=5}
    const url = `https://${storeDomain}/admin/api/${apiVersion}/orders/${orderId}.json`;

    const body = {
      order: {
        id: orderId,
        tags: newTagsStr,
      },
    };

    await axios.put(url, body, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });

    console.log('✅ Успешно добавихме tag "nekorekten-flagged" към поръчката.');
  } catch (err) {
    console.error(
      'Грешка при обновяване на таговете в Shopify:',
      err.response?.status,
      err.response?.data || err.message
    );
  }
}

// 3) Webhook handler за нови поръчки
app.post('/webhooks/orders/create', async (req, res) => {
  try {
    const order = req.body;
    console.log('➡️ Получихме order webhook:', order.id);

    // Извличаме телефон (както е най-често наличен)
    const phoneRaw =
      order.customer?.phone ||
      order.billing_address?.phone ||
      order.shipping_address?.phone ||
      '';

    const phone = normalizePhoneTo359(phoneRaw);

    console.log('Търсим в Nekorekten по телефон:', phone);

    // Проверяваме само по телефон
    const { hasReports } = await checkCustomerInNekorekten(phone);

    if (hasReports) {
      console.log('⚠️ ИМА намерени сигнали → добавяме флаг към поръчката.');
      await addFlagTagToOrder(order);
    } else {
      console.log('✅ Няма сигнали за този телефон.');
    }

    // Shopify трябва винаги да получава 200
    res.status(200).send('ok');

  } catch (err) {
    console.error('Грешка в orders/create webhook:', err);
    res.status(200).send('error');
  }
});


// Тестов route
app.get('/', (req, res) => {
  res.send('Nekorekten Shopify checker работи 🙂');
});

app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
});
