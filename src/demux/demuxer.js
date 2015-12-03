import Event from '../events';
import {ErrorTypes, ErrorDetails} from '../errors';
import DemuxerInline from '../demux/demuxer-inline';
import DemuxerWorker from '../demux/demuxer-worker';
import {logger} from '../utils/logger';
import MP4Remuxer from '../remux/mp4-remuxer';

class Demuxer {

  constructor(hls) {
    this.hls = hls;
    if (hls.config.enableWorker && (typeof(Worker) !== 'undefined')) {
        logger.log('demuxing in webworker');
        try {
          var work = require('webworkify');
          this.w = work(DemuxerWorker);
          this.onwmsg = this.onWorkerMessage.bind(this);
          this.w.addEventListener('message', this.onwmsg);
          this.w.postMessage({cmd: 'init'});
        } catch(err) {
          logger.error('error while initializing DemuxerWorker, fallback on DemuxerInline');
          this.demuxer = new DemuxerInline(hls,MP4Remuxer);
        }
      } else {
        this.demuxer = new DemuxerInline(hls,MP4Remuxer);
      }
      this.demuxInitialized = true;
  }

  destroy() {
    if (this.w) {
      this.w.removeEventListener('message', this.onwmsg);
      this.w.terminate();
      this.w = null;
    } else {
      this.demuxer.destroy();
    }
  }

  pushDecrypted(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration) {
    if (this.w) {
      // post fragment payload as transferable objects (no copy)
      this.w.postMessage({cmd: 'demux', data: data, audioCodec: audioCodec, videoCodec: videoCodec, timeOffset: timeOffset, cc: cc, level: level, sn : sn, duration: duration}, [data]);
    } else {
      this.demuxer.push(new Uint8Array(data), audioCodec, videoCodec, timeOffset, cc, level, sn, duration);
    }
  }

  push(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, decryptdata) {
    if ((data.byteLength > 0) && (decryptdata != null) && (decryptdata.key != null) && (decryptdata.method === 'AES-128')) {
      var localthis = this;
      window.crypto.subtle.importKey('raw', decryptdata.key, { name : 'AES-CBC', length : 128 }, false, ['decrypt']).
        then(function (importedKey) {
          window.crypto.subtle.decrypt({ name : 'AES-CBC', iv : decryptdata.iv.buffer }, importedKey, data).
            then(function (result) {
              localthis.pushDecrypted(result, audioCodec, videoCodec, timeOffset, cc, level, sn, duration);
            }).
            catch (function (err) {
              logger.error(`decrypting error : ${err.message}`);
              localthis.hls.trigger(Event.ERROR, {type : ErrorTypes.MEDIA_ERROR, details : ErrorDetails.FRAG_DECRYPT_ERROR, fatal : true, reason : err.message});
              return;
            });
        }).
        catch (function (err) {
          logger.error(`decrypting error : ${err.message}`);
          localthis.hls.trigger(Event.ERROR, {type : ErrorTypes.MEDIA_ERROR, details : ErrorDetails.FRAG_DECRYPT_ERROR, fatal : true, reason : err.message});
          return;
        });
    } else {
      this.pushDecrypted(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration);
    }
  }

  onWorkerMessage(ev) {
    //console.log('onWorkerMessage:' + ev.data.event);
    switch(ev.data.event) {
      case Event.FRAG_PARSING_INIT_SEGMENT:
        var obj = {};
        if (ev.data.audioMoov) {
          obj.audioMoov = new Uint8Array(ev.data.audioMoov);
          obj.audioCodec = ev.data.audioCodec;
          obj.audioChannelCount = ev.data.audioChannelCount;
        }
        if (ev.data.videoMoov) {
          obj.videoMoov = new Uint8Array(ev.data.videoMoov);
          obj.videoCodec = ev.data.videoCodec;
          obj.videoWidth = ev.data.videoWidth;
          obj.videoHeight = ev.data.videoHeight;
        }
        this.hls.trigger(Event.FRAG_PARSING_INIT_SEGMENT, obj);
        break;
      case Event.FRAG_PARSING_DATA:
        this.hls.trigger(Event.FRAG_PARSING_DATA,{
          moof: new Uint8Array(ev.data.moof),
          mdat: new Uint8Array(ev.data.mdat),
          startPTS: ev.data.startPTS,
          endPTS: ev.data.endPTS,
          startDTS: ev.data.startDTS,
          endDTS: ev.data.endDTS,
          type: ev.data.type,
          nb: ev.data.nb
        });
        break;
        case Event.FRAG_PARSING_METADATA:
        this.hls.trigger(Event.FRAG_PARSING_METADATA, {
          samples: ev.data.samples
        });
        break;
        case Event.FRAG_PARSING_USERDATA:
        this.hls.trigger(Event.FRAG_PARSING_USERDATA, {
          samples: ev.data.samples
        });
        break;
      default:
        this.hls.trigger(ev.data.event, ev.data.data);
        break;
    }
  }
}

export default Demuxer;

