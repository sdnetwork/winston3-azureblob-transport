import Transport from 'winston-transport';
import async from "async";
import * as azure from "azure-storage";
import moment from "moment";
import { MESSAGE } from "triple-beam";

const debug = require("debug")("winston3-azureblob-transport");

var loggerDefaults = {
  account: {
    name: "YOUR_ACCOUNT_NAME",
    key: "YOUR_ACCOUNT_KEY"
  },
  containerName: "YOUR_CONTAINER",
  blobName: "YOUR_BLOBNAME",
  eol: "\n", // End of line character two concate log
  rotatePeriod: "", // moment format to rotate ,empty if you don't want rotate
  // due to limitation of 50K block in azure blob storage we add some params to avoid the limit
  bufferLogSize: -1, // minimum numners of log before send the block
  syncTimeout: 0 // maximum time between two push to azure blob    
};

const MAX_APPEND_BLOB_BLOCK_SIZE = 4 * 1024 * 1024;


interface IAzureBlob {
  azBlobClient: azure.BlobService
  containerName: string
  blobName: string
  rotatePeriod: string
  EOL: string
  bufferLogSize: number
  syncTimeout: number
  buffer: Array<any>;
  timeoutFn: NodeJS.Timeout | null;
}

//
// Inherit from `winston-transport` so you can take advantage
// of the base functionality and `.exceptions.handle()`.
//
export class AzureBlob extends Transport implements IAzureBlob {

  azBlobClient: azure.BlobService
  containerName: string
  blobName: string
  rotatePeriod: string
  EOL: string
  bufferLogSize: number
  syncTimeout: number
  buffer: Array<any>;
  timeoutFn: NodeJS.Timeout | null;

  constructor(opts: Transport.TransportStreamOptions) {
    super(opts);

    const options = {...loggerDefaults,...opts};

    // create az blob client
    this.azBlobClient = this._createAzClient(options.account);
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

  push(data: any, callback: { (): void; (): void; }) {
    if (data)
      this.buffer.push(data);
    if (this.bufferLogSize < 1 || this.buffer.length >= this.bufferLogSize) {
      this._logToAppendBlob(this.buffer, callback); // in this case winston buffer for us
      this.buffer = [];
    } else if (this.syncTimeout && this.timeoutFn === null) {

      this.timeoutFn = setTimeout(() => {
        let tasks = this.buffer.slice(0);
        this.buffer = [];
        this.timeoutFn = null; // as we can receive push again after timeout we must relaunch the timeout 
        this._logToAppendBlob(tasks, () => {
          debug("Finish to appendblock", tasks.length);
        });
      }, this.syncTimeout)
      callback();
    } else {
      // buffering
      callback();
    }
  }

  log(info: any, callback: () => void) {
    this.push(info, () => {
      this.log('logged', info)
      // this.emit('logged', info);
      callback();
    })
  }

  _createAzClient(account_info: { name: any; key: any; }) {
    return azure.createBlobService(account_info.name, account_info.key);
  }

  _chunkString(str: string, len: number) {
    const size = Math.ceil(str.length / len)
    const r = Array(size)
    let offset = 0

    for (let i = 0; i < size; i++) {
      r[i] = str.substr(offset, len)
      offset += len
    }

    return r
  }

  _logToAppendBlob(tasks: any[], callback: async.ErrorCallback<Error>) {
    debug("Try to appendblock", tasks.length);
    if (tasks.length == 0) // nothing to log
      return callback();
    const azClient = this.azBlobClient;
    const containerName = this.containerName;
    let blobName = this.blobName;
    if (this.rotatePeriod)
      blobName = blobName + "." + moment().format(this.rotatePeriod);

    let toSend = tasks.map((item: any) => item[MESSAGE]).join(this.EOL) + this.EOL;
    let chunks = this._chunkString(toSend, MAX_APPEND_BLOB_BLOCK_SIZE);
    debug("Numbers of appendblock needed", chunks.length);
    debug("Size of chunks", toSend.length);
    async.eachSeries(chunks, (chunk, nextappendblock) => {
      azClient.appendBlockFromText(containerName, blobName, chunk, {}, function (err, _result) {
        if (err) {
          if (err.name === "BlobNotFound") {
            return azClient.createAppendBlobFromText(containerName, blobName, chunk, {}, function (err, _result) {
              if (err)
                debug("Error during appendblob creation", err.name);
              nextappendblock();
            })
          }
          debug("Error during appendblob operation", err.name);
        }
        nextappendblock();
      })
    }, callback)
  }
};