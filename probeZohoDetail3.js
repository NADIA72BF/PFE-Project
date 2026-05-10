const fetch = require('node-fetch');
const token = '1000.a73f68ca66bc3baecca47a99f36f0cba.7f9de4d1e13f227f45d4038ef9b478c2';
const id = '4899073000000090300';
const bases = ['https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re', 'https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re'];
const paths = [
  `form/Property/record?criteria=(ID==${id})`,
  `form/Property/record?criteria=(ID==\"${id}\")`,
  `form/Property/record?criteria=(ID==${id})&raw=true`,
  `form/Property/record?criteria=(ID==${id})&select=Image`,
  `form/Property/record?criteria=(Image!=null)`,
  `report/all_prop?criteria=(ID==${id})`,
  `report/all_prop?criteria=(ID==${id})&select=Image`,
  `report/all_prop?criteria=(Image!=null)`
];
(async () => {
  for (const base of bases) {
    for (const p of paths) {
      const url = `${base}/${p}`;
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
        const text = await res.text();
        console.log('BASE:', base, 'PATH:', p);
        console.log('STATUS:', res.status, res.statusText);
        console.log(text.slice(0, 600));
      } catch (err) {
        console.error('ERROR:', base, p, err.message);
      }
      console.log('-----');
    }
  }
})();
