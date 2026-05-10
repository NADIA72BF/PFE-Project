const fs=require('fs');
const data = JSON.parse(fs.readFileSync('api_properties_include.json','utf8'));
const p = data.data[0];
console.log(Object.keys(p));
console.log(JSON.stringify(Object.entries(p).filter(([k]) => k.toLowerCase().includes('image') || k.toLowerCase().includes('photo') || k.toLowerCase().includes('pics')), null, 2));
