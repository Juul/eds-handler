'use strict';

const fs = require('fs');
const path = require('path');
const through = require('through2');
const klaw = require('klaw');
const JSZip = require('jszip');
const JSDOM = require('jsdom').JSDOM;

if(typeof Node === 'undefined') {
  var ELEMENT_NODE = 1;
  var TEXT_NODE = 3;
}

const ROWS = 8;
const COLS = 12;

// We are modifying these files
// so skip them when copying from template
const skipFiles = [
  'experiment.xml',
  'plate_setup.xml',
  'analysis_protocol.xml'
];

// char code for uppercase A
const aCharCode = 'A'.charCodeAt(0);


function parseDOM(str, mimetype) {
  return new JSDOM(str, {
    contentType: mimetype
  }).window.document;
}

function loadTemplate(filepath, cb) {
  fs.readFile(filepath, {encoding: 'utf8'}, function(err, data) {
    if(err) return cb(err);

    try {
      const doc = parseDOM(data, 'application/xml');
      cb(null, doc);
    } catch(e) {
      return cb(e);
    }
    
  });
}


function wellRowToNumber(wellRow) {
  wellRow = wellRow.toUpperCase();
  const val = wellRow.charCodeAt(0) - aCharCode;
  if(val < 0 || val >= ROWS) throw new Error("Invalid well row: " + wellRow);
  return val;
}

// expects that we're counting from zero
function wellRowToLetter(wellRow) {
  if(wellRow >= 12) throw new Error("Well row too high for 96 well plate");
  return String.fromCharCode(aCharCode + wellRow);
}

function wellToIndex(wellName) {
  if(typeof wellName !== 'string' || wellName.length < 2 || wellName.length > 3) {
    throw new Error("Invalid well name: " + wellName);
  }

  const rowIndex = wellRowToNumber(wellName);
  const colIndex = parseInt(wellName.slice(1)) - 1;
  if(colIndex < 0 || colIndex >= COLS) {
    throw new Error("Invalid column number: " + colIndex);
  }

  return rowIndex * COLS + colIndex;
}

function wellIndexToName(wellIndex) {
  const col = (wellIndex % 12) + 1;
  const row = Math.floor(wellIndex / 12);

  return wellRowToLetter(row)+col;
}

function removeNodes(nodes) {
  if(!nodes || !nodes.length) return 0;

  const parent = nodes[0].parentNode;
  if(!parent) throw new Error("Can't remove node: Node has no parent");

  var count = 0;
  var node;
  for(node of nodes) {
    parent.removeChild(node);
    count++;
  }
  return count;
}

function newTag(doc, name, content) {
  const node = doc.createElement(name);
  if(typeof content === 'string') {
    node.innerHTML = content;
  } else if(typeof content === 'number') {
    node.innerHTML = content.toString();
  } else {
    node.appendChild(content);
  }
  return node;
}

function newSample(doc, name, forExperiment) {
  const sample = doc.createElement((forExperiment) ? 'Samples' : 'Sample');
  var color;
  if(name === false) {
    name = 'NTC';
    color = '-8076815';
  } else if(name === true) {
    name = 'POS';
    color = '-5701666';
  } else {
    color = '-2105970';
  }
  sample.appendChild(newTag(doc, 'Name', name))
  sample.appendChild(newTag(doc, 'Color', color))
  
  if(forExperiment) {
    sample.appendChild(newTag(doc, 'Concentration', '100.0'))
  }
  return sample;
}

function newSampleFeatureValue(doc, index, sampleName) {
  const fv = doc.createElement('FeatureValue');

  fv.appendChild(
    newTag(doc, 'Index', index)
  );

  fv.appendChild(
    newTag(doc, 'FeatureItem', newSample(doc, sampleName))
  );  
  
  return fv;
}

function newDetectorFeatureValue(doc, index) {
  const el = doc.createElement('FeatureValue');
  el.appendChild(
    newTag(doc, 'Index', index)
  );
  el.appendChild(
    newTag(doc, 'FeatureItem',
`           <DetectorTaskList>
                    <DetectorTask>
                        <Task>UNKNOWN</Task>
                        <Concentration>1.0</Concentration>
                        <Detector>
                            <Name>Target 1</Name>
                            <Reporter>FAM</Reporter>
                            <Quencher>None</Quencher>
                            <Color>-7619079</Color>
                        </Detector>
                    </DetectorTask>
                    <DetectorTask>
                        <Task>UNKNOWN</Task>
                        <Concentration>1.0</Concentration>
                        <Detector>
                            <Name>Target 2</Name>
                            <Reporter>VIC</Reporter>
                            <Quencher>None</Quencher>
                            <Color>-3083422</Color>
                        </Detector>
                    </DetectorTask>
                </DetectorTaskList>
`))

  return el;
}

function findFeatureMapWithID(doc, id) {
  const nodes = doc.querySelectorAll('Plate > FeatureMap > Feature > Id');
  var featureMap;
  for(let node of nodes) {
    if(node.innerHTML === id) {
      featureMap = node.parentNode.parentNode;
      break;
    }
  }
  if(!featureMap) {
    throw new Error("Unable to find "+id+" FeatureMap in plate_setup.xml template");
  }
  return featureMap;
}

function genPlateSetup(data, cb) {
  if(!data.barcode || !data.wells) {
    return cb(new Error("barcode and wells are required in order to generate plate_setup.xml"));
  }
  loadTemplate('template/apldbio/sds/plate_setup.xml', function(err, doc) {
    if(err) return cb(err);

    var node = doc.querySelector('Plate > BarCode');
    node.innerHTML = data.barcode;

    node = doc.querySelector('Plate > Name');
    node.innerHTML = data.name || "Unnamed plate";

    node = doc.querySelector('Plate > Description');
    node.innerHTML = data.description || "Generated by renegade-lims";
    
    var featureMap = findFeatureMapWithID(doc, 'sample');
    var nodes = featureMap.querySelectorAll('FeatureValue');
    removeNodes(nodes);

    var wellName, wellIndex, sampleName;
    for(wellName in data.wells) {
      wellIndex = wellToIndex(wellName);
      sampleName = data.wells[wellName];
      
      featureMap.appendChild(
        newSampleFeatureValue(doc, wellIndex, sampleName)
      );
    }

    featureMap = findFeatureMapWithID(doc, 'detector-task');
    nodes = featureMap.querySelectorAll('FeatureValue');
    removeNodes(nodes);
    
    for(wellName in data.wells) {
      wellIndex = wellToIndex(wellName);
      
      featureMap.appendChild(
        newDetectorFeatureValue(doc, wellIndex)
      );
    }

    cb(null, doc.documentElement.outerHTML);
  });  
}




function genExperiment(dirpath, filename, data, cb) {
  loadTemplate('template/apldbio/sds/experiment.xml', function(err, doc) {
    if(err) return cb(err);

    var node = doc.querySelector('Experiment > Name');
    node.innerHTML = data.name || "Unnamed experiment";

    node = doc.querySelector('Experiment > Operator');
    node.innerHTML = data.operator || "Unknown operator";

    node = doc.querySelector('Experiment > FileName');
    node.innerHTML = dirpath + '\\' + filename;

    var nodes = doc.querySelectorAll('Experiment > Samples');
    var ref = nodes[nodes.length - 1].nextSibling;

    removeNodes(nodes);

    var allSamples = [];

    var wellName, sampleName, wellIndex;
    for(wellName in data.wells) {
      wellIndex = wellToIndex(wellName);
      sampleName = data.wells[wellName];
      
      allSamples.push({
        index: wellIndex,
        node: newSample(doc, sampleName, true)
      });
    }

    allSamples.sort(function(a, b) {
      return a.index - b.index;
    })

    var sample;
    for(sample of allSamples) {
      ref.parentNode.insertBefore(sample.node, ref);
    }
    
    cb(null, doc.documentElement.outerHTML);
  });
}



function shouldSkip(filepath) {
  var checkpath;
  for(checkpath of skipFiles) {
    if(filepath.match(new RegExp(checkpath+'$'))) {
      return true;
    }
  }
  return false;
}

function edsFromTemplate(plateSetup, experiment, analysisProtocol, cb) {
  const zip = new JSZip();
  const pathStream = klaw('template');

  var curPath;
  pathStream.pipe(through.obj(function(item, enc, next) {

    curPath = path.relative('template', item.path)

    if(item.stats.isDirectory()) {
      zip.folder(curPath);
    } else {
      if(shouldSkip(curPath)) {
        return next();
      }
      zip.file(curPath, fs.createReadStream(item.path));
    }
    next();
  }));

  pathStream.on('end', function() {

    zip.file('apldbio/sds/plate_setup.xml', plateSetup);
    zip.file('apldbio/sds/experiment.xml', experiment);
    zip.file('apldbio/sds/analysis_protocol.xml', analysisProtocol);
    
    zip.generateAsync({
      type: 'nodebuffer',
      compression: "DEFLATE",
      compressionOptions: {
        level: 6
      }
    }).then(function(zipData) {
      cb(null, zipData);
    }).catch(cb);
  });

  pathStream.on('error', cb);  
}

function newAnalysisSettings(doc, wellIndex, target) {
  const el = doc.createElement('JaxbAnalysisSettings');
  el.innerHTML =
        `<Type>com.apldbio.sds.platform.analysis.IWellSettings</Type>
        <JaxbSettingValue>
            <Name>AutoBaseline</Name>
            <JaxbValueItem type="Boolean">
                <BooleanValue>false</BooleanValue>
            </JaxbValueItem>
        </JaxbSettingValue>
        <JaxbSettingValue>
            <Name>BaselineStart</Name>
            <JaxbValueItem type="Integer">
                <IntValue>3</IntValue>
            </JaxbValueItem>
        </JaxbSettingValue>
        <JaxbSettingValue>
            <Name>ObjectName</Name>
            <JaxbValueItem type="String">
                <StringValue>${target}</StringValue>
            </JaxbValueItem>
        </JaxbSettingValue>
        <JaxbSettingValue>
            <Name>BaselineStop</Name>
            <JaxbValueItem type="Integer">
                <IntValue>15</IntValue>
            </JaxbValueItem>
        </JaxbSettingValue>
        <JaxbSettingValue>
            <Name>WellIndex</Name>
            <JaxbValueItem type="Integer">
                <IntValue>${wellIndex}</IntValue>
            </JaxbValueItem>
        </JaxbSettingValue>
        <JaxbSettingValue>
            <Name>UseDetectorDefaults</Name>
            <JaxbValueItem type="Boolean">
                <BooleanValue>true</BooleanValue>
            </JaxbValueItem>
        </JaxbSettingValue>`;
  return el;
}


function makeAllAnalysisSettings(doc, wells, target) {
  var nodes = [];
  var wellName, wellIndex;
  for(wellName in wells) {
    wellIndex = wellToIndex(wellName);

    nodes.push(
      newAnalysisSettings(doc, wellIndex, target)
    );
  }

  return nodes;
}

function apGetType(node) {
  node = node.querySelector('Type');
  if(!node) return null;
  return node.innerHTML.trim();
}

function apGetObjectName(settingsNode) {
  var valueNodes = settingsNode.querySelectorAll('JaxbSettingValue');
  var valNode, node;
  for(valNode of valueNodes) {
    node = valNode.querySelector('Name');
    if(!node) continue;
    if(node.innerHTML.trim() !== 'ObjectName') continue;
    node = valNode.querySelector('JaxbValueItem > StringValue');
    if(!node) continue;
    return node.innerHTML.trim();
  }
  return null;
}

function insertAllBefore(nodes, beforeNode) {
  const parentNode = beforeNode.parentNode;
  var node;
  for(node of nodes) {
    parentNode.insertBefore(node, beforeNode);
  }
}

function genAnalysisProtocol(data, cb) {
  loadTemplate('template/apldbio/sds/analysis_protocol.xml', function(err, doc) {
    if(err) return cb(err);

    var nodes = doc.querySelectorAll('JaxbAnalysisProtocol > JaxbAnalysisSettings');
    var node, objectName;
    var toDelete = [];
    for(node of nodes) {
      if(!node) continue;
      if(apGetType(node) !== 'com.apldbio.sds.platform.analysis.IWellSettings') {
        continue;
      }
      objectName = apGetObjectName(node)
      if(!objectName || !objectName.match(/Target\s+\d+/)) {
        continue;
      }
      toDelete.push(node);
    }

    var ref = toDelete[toDelete.length-1].nextSibling;;
    
    removeNodes(toDelete);
    
    nodes = makeAllAnalysisSettings(doc, data.wells, 'Target 1');
    insertAllBefore(nodes, ref);
    
    nodes = makeAllAnalysisSettings(doc, data.wells, 'Target 2');
    insertAllBefore(nodes, ref);    
    
    cb(null, doc.documentElement.outerHTML);
  });
}


function generate(dirPath, filename, data, cb) {
  genPlateSetup(data, function(err, plateSetup) {
    if(err) return cb(err);
    
    genExperiment(dirPath, filename, data, function(err, experiment) {
      if(err) return cb(err);

      genAnalysisProtocol(data, function(err, analysisProtocol) {
        if(err) return cb(err);
        
        edsFromTemplate(plateSetup, experiment, analysisProtocol, cb);

      });
    });
  });
}


function loadZip(filepathOrData, cb) {
  if(typeof filepathOrData === 'string') {
    fs.readFile(filepathOrData, function(err, data) {
      if(err) return cb(err);
      
      JSZip.loadAsync(data, {}).then(function(zip) {
        cb(null, zip);
      }).catch(cb);
    });
  } else {
    
    JSZip.loadAsync(filepathOrData, {}).then(function(zip) {
        cb(null, zip);
    }).catch(cb);
  }
}

function getPlateMetadata(zip, cb) {
  zip.file('apldbio/sds/plate_setup.xml').async('text').then(function(str) {
    const doc = parseDOM(str, 'application/xml');

    var node = doc.querySelector("Plate > BarCode");
    if(!node || !node.innerHTML || !node.innerHTML.trim()) {
      return cb(new Error("Plate barcode not found"));
    }

    const metadata = {
      barcode: node.innerHTML.trim()
    };
    
    node = doc.querySelector("Plate > Name");
    if(node && node.innerHTML && node.innerHTML.trim()) {
      metadata.plateName = node.innerHTML.trim();
    }

    node = doc.querySelector("Plate > Description");
    if(node && node.innerHTML && node.innerHTML.trim()) {
      metadata.plateDescription = node.innerHTML.trim();
    }

    zip.file('apldbio/sds/experiment.xml').async('text').then(function(str) {
      const doc = parseDOM(str, 'application/xml');

      var node = doc.querySelector("Experiment > RunState");
      if(!node || !node.innerHTML || !node.innerHTML.trim()) {
        return cb(new Error("Experiment run state not found"));
      }
      if(node.innerHTML.trim().toLowerCase() !== 'complete') {
        return cb(new Error("This .eds file does not contain a completed experiment"));
      }

      node = doc.querySelector("Experiment > Operator");
      if(node && node.innerHTML && node.innerHTML.trim()) {
        metadata.operatorName = node.innerHTML.trim();
      }
      
      cb(null, metadata);
      
    }).catch(cb);
    
  }).catch(cb);
}

function fieldsToObject(header, fields) {
  var o = {};
  var i, key;
  for(i=0; i < header.length; i++) {
    key = header[i];
    o[key] = fields[i];
  }
  return o;
}

function parseAnalysisResult(zip, cb) {
  zip.file('apldbio/sds/analysis_result.txt').async('text').then(function(data) {  

    const lines = data.split(/\r?\n/);
    
    var header;

    var output = [];
    
    var line, fields, wellIndex;
    for(line of lines) {
      fields = line.split(/\t/);
      if(!fields[0]) continue;
      if(fields[0].trim().toLowerCase() === 'well') {
        header = fields;
        continue;
      }
      if(!header) continue;
      
      wellIndex = parseInt(fields[0]);
      if(typeof wellIndex !== 'number' || !(wellIndex >= 0)) {
        continue;
      }
      output.push(
        fieldsToObject(header, fields)
      );
    }    
    
    cb(null, output);

  }).catch(cb);
}

function niceHeader(header) {
  var i;
  for(i=0; i < header.length; i++) {
    if(!header[i]) continue;
    header[i] = header[i].trim().toLowerCase().replace(/\s+/, '_');
  }
  return header;
}

function parseMultiComponentData(zip, cb) {
  zip.file('apldbio/sds/multicomponent_data.txt').async('text').then(function(data) {  

    const lines = data.split(/\r?\n/);
    
    var header;

    var wells = {};
    
    var line, fields, wellIndex, wellName, dye, cycle, value;
    for(line of lines) {
      fields = line.split(/\t/);
      if(!fields[0]) continue;
      if(fields[0].trim().toLowerCase() === 'well') {
        header = niceHeader(fields);
        continue;
      }
      if(!header) continue;
      
      wellIndex = parseInt(fields[0]);
      if(typeof wellIndex !== 'number' || !(wellIndex >= 0)) {
        continue;
      }

      if(fields.length < 5) {
        continue;
      }

      wellName = wellIndexToName(wellIndex);

      if(!wells[wellName]) {
        wells[wellName] = {}
      }

      while(fields[2] && !fields[2].match(/[a-zA-Z]/)) {
        fields = fields.slice(3);
      }
      
      dye = fields[2];
      if(!dye) continue;

      cycle = fields[1];
      value = fields[4];

      if(!wells[wellName][dye]) {
        wells[wellName][dye] = [];
      }

      wells[wellName][dye][cycle] = value;
    }    
    
    cb(null, wells);

  }).catch(cb);
}

function parse(filepathOrData, cb) {
  loadZip(filepathOrData, function(err, zip) {
    if(err) return cb(err);
    
    getPlateMetadata(zip, function(err, metadata) {
      if(err) return cb(err);

      parseAnalysisResult(zip, function(err, results) {
        if(err) return cb(err);

        parseMultiComponentData(zip, function(err, wells) {
          if(err) return cb(err);
        
          console.log('got:', wells['B9']['VIC'][33]);

        });
      });
    });
  });
}


module.exports = {
  generate,
  parse
}
