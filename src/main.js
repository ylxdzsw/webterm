'use strict';

const fs = require('fs');
const path = require('path');
const sea = require('node:sea');
const { version } = require('../package.json');

const command = process.argv[2];

if (command === '--version') {
  console.log(
    sea.isSea() ? sea.getAsset('meta/version.txt', 'utf8').trim() : `webterm ${version}`
  );
} else if (command === '--licenses') {
  const text = sea.isSea()
    ? sea.getAsset('meta/licenses.txt', 'utf8')
    : fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8');
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
} else {
  require('./server');
}
