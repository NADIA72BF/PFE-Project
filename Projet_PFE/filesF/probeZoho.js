const fetch = require('node-fetch');
const token = '1000.a73f68ca66bc3baecca47a99f36f0cba.7f9de4d1e13f227f45d4038ef9b478c2';
const id = '4899073000000090300';
const endpoints = [
  `https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/form/Property/record/${id}`,
  `https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re/form/Property/record/${id}`,
  `https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/report/all_prop/record/${id}`,
  `https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re/report/all_prop/record/${id}`,
  `https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/form/Property/record/${id}?raw=true`,
  `https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re/form/Property/record/${id}?raw=true`,
  `https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/report/all_prop/record/${id}?raw=true`,
  `https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re/report/all_prop/record/${id}?raw=true`,
  `https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/form/Property/${id}`,
  `https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re/form/Property/${id}`,
  `https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/report/all_prop/${id}`,
  `https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re/report/all_prop/${id}`
];
(async () => {
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      console.log(url, res.status, res.statusText);
      const text = await res.text();
      console.log(text.slice(0, 350));
    } catch (err) {
      console.error(url, 'ERROR', err.message);
    }
    console.log('---');
  }
})();
