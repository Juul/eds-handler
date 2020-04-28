#!/usr/bin/env node

const fs = require('fs');
const eds = require('../index.js');


eds.generate(
  'C:\\somedir',
  'somefile.eds',
  {
    barcode: '1337',
    name: 'Some experiment',
    operator: 'Someone',
    wells: {
      'A1': 'a001',
      'A2': 'a002',
      'C4': 'a028',
      'H12': false,
      'H11': true
    }
  }, function(err, result) {
    if(err) return console.error("Error:", err);
    
    fs.writeFileSync('out.eds', result);
});

