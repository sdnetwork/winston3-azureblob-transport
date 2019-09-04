const Transport = require('winston-transport');
const async = require("async");
const azure = require("azure-storage");
const moment = require("moment");
const MESSAGE = require('triple-beam').MESSAGE;
const debug = require("debug")("winston3-azureblob-transport");

var loggerDefaults = {
    account: {
        name: "YOUR_ACCOUNT_NAME",
        key: "YPOUR_ACCOUNT_KEY"
      },
    containerName: "YOUR_CONTAINER",
    blobName: "YOUR_BLOBNAME",
    eol : "\n", // End of line character two concate log
    rotatePeriod : "", // moment format to rotate ,empty if you don't want rotate
    // due to limitation of 50K block in azure blob storage we add some params to avoid the limit
    bufferLogSize : -1, // minimum numners of log before send the block
    syncTimeout : 0 // maximum time between two push to azure blob    
};

const MAX_APPEND_BLOB_BLOCK_SIZE = 4 * 1024 * 1024;

//
// Inherit from `winston-transport` so you can take advantage
// of the base functionality and `.exceptions.handle()`.
//
module.exports = class AzureBlob extends Transport {
  constructor(opts) {
    super(opts);
    
    let options = Object.assign({}, loggerDefaults, opts);

    // create az blolb client
    this.azblobclient = this._createAzClient(options.account);
    this.containerName = options.containerName;
    this.blobName = options.blobName;
    this.rotatePeriod = options.rotatePeriod;
    this.EOL = options.eol;
    this.bufferLogSize = options.bufferLogSize;
    this.syncTimeout = options.syncTimeout;
    if (this.bufferLogSize > 1 && !this.syncTimeout) {
      throw new Error("syncTimeout must be set, if there is a bufferLogSize");
    }
    this.buffer = [];
    this.timeoutFn = null;
  }
  
  push(data, callback) {
    var _self = this;
    if (data)
      this.buffer.push(data);
    if (_self.bufferLogSize < 1 || _self.buffer.length >= _self.bufferLogSize) {
      this._logtoappendblob(_self.buffer, callback); // in this case winston buffer for us
      _self.buffer = [];
    } else if (_self.syncTimeout && _self.timeoutFn === null) {
        _self.timeoutFn = setTimeout(() => {
          let tasks = _self.buffer.slice(0);
          _self.buffer = [];
          _self.timeoutFn = null; // as we can receive push again after timeout we must relaunch the timeout 
          _self._logtoappendblob(tasks, () => {            
            debug("Finish to appendblock", tasks.length);
          });
        }, _self.syncTimeout)
        callback();
    } else {
      // buffering
      callback();
    }
  }

  log(info, callback) {
    this.push(info, () => {
      this.emit('logged', info);
      callback();
    })
  }

  _createAzClient(account_info) {
    return azure.createBlobService(account_info.name, account_info.key);
  }

  _chunkString (str, len) {
    const size = Math.ceil(str.length/len)
    const r = Array(size)
    let offset = 0
    
    for (let i = 0; i < size; i++) {
      r[i] = str.substr(offset, len)
      offset += len
    }
    
    return r
  }

  _logtoappendblob(tasks, callback) {
    debug("Try to appendblock", tasks.length);
    if (tasks.length == 0) // nothing to log
      return callback();
    const azclient = this.azblobclient;
    const containerName = this.containerName;
    let blobName = this.blobName;
    if (this.rotatePeriod)
      blobName = blobName + "." + moment().format(this.rotatePeriod);

    let tosend = tasks.map((item) => item[MESSAGE]).join(this.EOL) + this.EOL;
    let chuncks = this._chunkString(tosend, MAX_APPEND_BLOB_BLOCK_SIZE);
    debug("Numbers of appendblock needed", chuncks.length);
    debug("Size of chunks", tosend.length);
    async.eachSeries(chuncks, (chunck, nextappendblock) => {
      azclient.appendBlockFromText(containerName, blobName, chunck, {}, function (err, result) {
        if (err) {
          if (err.code === "BlobNotFound") {
            return azclient.createAppendBlobFromText(containerName, blobName, chunck, {}, function (err, result) {
              if (err)
                debug("Error during appendblob creation", err.code);
                nextappendblock();
            })
          }          
          debug("Error during appendblob operation", err.code);
        }
        nextappendblock();
      })
    }, callback)
  }
  
};