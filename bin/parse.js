#!/usr/bin/env node

const eds = require('../index.js');

eds.parse('test.eds', function(err, result) {
  if(err) return console.error("Error:", err);

  console.log("Got:", result.metadata);
  console.log("Got:", result.wells['A1']);
});

