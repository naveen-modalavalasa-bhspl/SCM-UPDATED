const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file:///' + process.argv[2].replace(/\/g,'/'));
  await p.pdf({ path: process.argv[3], format: 'A4', printBackground: true });
  await b.close();
})();
