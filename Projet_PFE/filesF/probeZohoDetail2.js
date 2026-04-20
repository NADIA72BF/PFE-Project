const fetch = require('node-fetch');
const token = '1000.a73f68ca66bc3baecca47a99f36f0cba.7f9de4d1e13f227f45d4038ef9b478c2';
const id = '4899073000000090300';
const base = 'https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re';
const urls = [
  `${base}/form/Property/record?criteria=(ID==${id})`,
  `${base}/form/Property/record?criteria=(ID==${id})&raw=true`,
  `${base}/form/Property/record?criteria=("ID"==${id})`,
  `${base}/form/Property/record?criteria=("ID"=="${id}")`,
  `${base}/form/Property/record?criteria=(ID==${id})&select=Image`,
  `${base}/report/all_prop?criteria=(ID==${id})`,
  `${base}/report/all_prop?criteria=(ID==${id})&select=Image`,
  `${base}/form/Property/record?criteria=%28ID==${id}%29`
];
(async () => {
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      const text = await res.text();
      console.log('URL:', url);
      console.log('STATUS:', res.status, res.statusText);
      console.log(text.slice(0, 600));
    } catch (err) {
      console.error('ERROR:', url, err.message);
    }
    console.log('-----');
  }
})();
