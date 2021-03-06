'use strict';

var _ = require('lodash');
var async = require('async');
var times = require('../times');
var fitTreatmentsToBGCurve = require('./treatmenttocurve');

var ONE_DAY = 86400000
  , TWO_DAYS = 172800000;

function uniq(a) {
  var seen = {};
  return a.filter(function (item) {
    return seen.hasOwnProperty(item.mills) ? false : (seen[item.mills] = true);
  });
}

function init(env, ctx) {

  var dataloader = { };

  dataloader.update = function update(ddata, done) {

    ddata.lastUpdated = Date.now();

    function loadComplete (err, result) {
      ddata.treatments = _.uniq(ddata.treatments, false, function (item) { return item._id.toString(); });
      //sort treatments so the last is the most recent
      ddata.treatments = _.sortBy(ddata.treatments, function (item) { return item.mills; });
      fitTreatmentsToBGCurve(ddata, env.settings);
      if (err) {
        console.error(err);
      }
      ddata.processTreatments();

      var counts = [];
      _.forIn(ddata, function each (value, key) {
        if (_.isArray(value) && value.length > 0) {
          counts.push(key + ':' + value.length);
        }
      });

      console.info('Load Complete:\n\t', counts.join(', '));

      done(err, result);
    }

    // clear treatments, we're going to merge from more queries
    ddata.treatments = [];
    
    async.parallel([
      loadEntries.bind(null, ddata, ctx)
      , loadTreatments.bind(null, ddata, ctx)
      , loadProfileSwitchTreatments.bind(null, ddata, ctx)
      , loadSensorAndInsulinTreatments.bind(null, ddata, ctx)
      , loadProfile.bind(null, ddata, ctx)
      , loadDeviceStatus.bind(null, ddata, env, ctx)
    ], loadComplete);

  };

  return dataloader;

}

function loadEntries (ddata, ctx, callback) {
  var q = {
    find: {
      date: {
        $gte: ddata.lastUpdated - TWO_DAYS
      }
    }
    , sort: {date: 1}
  };

  ctx.entries.list(q, function (err, results) {
    if (!err && results) {
      var mbgs = [];
      var sgvs = [];
      var cals = [];
      results.forEach(function (element) {
        if (element) {
          if (element.mbg) {
            mbgs.push({
              mgdl: Number(element.mbg), mills: element.date, device: element.device
            });
          } else if (element.sgv) {
            sgvs.push({
              mgdl: Number(element.sgv), mills: element.date, device: element.device, direction: element.direction, filtered: element.filtered, unfiltered: element.unfiltered, noise: element.noise, rssi: element.rssi
            });
          } else if (element.type === 'cal') {
            cals.push({
              mills: element.date, scale: element.scale, intercept: element.intercept, slope: element.slope
            });
          }
        }
      });
      ddata.mbgs = uniq(mbgs);
      ddata.sgvs = uniq(sgvs);
      ddata.cals = uniq(cals);
    }
    callback();
  });
}

function mergeToTreatments (ddata, results) {
  var filtered = _.filter(results, function hasId (treatment) {
    return _.isObject(treatment._id);
  });

  var treatments = _.map(filtered, function update (treatment) {
    treatment.mills = new Date(treatment.created_at).getTime();
    return treatment;
  });

  //filter out temps older than a day and an hour ago since we don't display them
  var oneDayAgo = ddata.lastUpdated - ONE_DAY - times.hour().msecs;
  treatments = _.filter(treatments, function noOldTemps (treatment) {
    return !treatment.eventType || treatment.eventType.indexOf('Temp Basal') === -1 || treatment.mills > oneDayAgo;
  });

  ddata.treatments = _.union(ddata.treatments, treatments);
}

function loadTreatments (ddata, ctx, callback) {
  var tq = {
    find: {
      created_at: {
        $gte: new Date(ddata.lastUpdated - (ONE_DAY * 8)).toISOString()
      }
    }
    , sort: {created_at: 1}
  };

  ctx.treatments.list(tq, function (err, results) {
    if (!err && results) {
      mergeToTreatments(ddata, results);
    }

    callback();
  });
}

function loadProfileSwitchTreatments (ddata, ctx, callback) {
  var tq = {
    find: {
      eventType: {
        $eq: 'Profile Switch'
      }
      , created_at: {
        $gte: new Date(ddata.lastUpdated - (ONE_DAY * 31 * 12)).toISOString()
      }
    }
    , sort: {created_at: -1}
  };

  ctx.treatments.list(tq, function (err, results) {
    if (!err && results) {
      mergeToTreatments(ddata, results);
    }

    // Store last profile switch
    if (results) {
      ddata.lastProfileFromSwitch = null;
      var now = new Date().getTime();
      for (var p = 0; p < results.length; p++ ) {
        var pdate = new Date(results[p].created_at).getTime();
        if (pdate < now) {
          ddata.lastProfileFromSwitch = results[p].profile;
          break;
        }
      }
    }
    
    callback();
  });
}

function loadSensorAndInsulinTreatments (ddata, ctx, callback) {
  var tq = {
    find: {
      eventType: {
        $in: [ 'Sensor Start', 'Sensor Change','Insulin Change']
      }
      , created_at: {
        $gte: new Date(ddata.lastUpdated - (ONE_DAY * 32)).toISOString()
      }
    }
    , sort: {created_at: -1}
  };

  ctx.treatments.list(tq, function (err, results) {
    if (!err && results) {
      mergeToTreatments(ddata, results);
    }

    callback();
  });
}

function loadProfile (ddata, ctx, callback) {
  ctx.profile.last(function (err, results) {
    if (!err && results) {
      var profiles = [];
      results.forEach(function (element) {
        if (element) {
            profiles[0] = element;
        }
      });
      ddata.profiles = profiles;
    }
    callback();
  });
}

function loadDeviceStatus (ddata, env, ctx, callback) {
  var opts = {
    find: {
      created_at: {
        $gte: new Date(ddata.lastUpdated - ONE_DAY).toISOString()
      }
    }
    , sort: {created_at: -1}
  };

  if (env.extendedSettings.devicestatus && env.extendedSettings.devicestatus.advanced) {
    //not adding count: 1 restriction
  } else {
    opts.count = 1;
  }

  ctx.devicestatus.list(opts, function (err, results) {
    if (!err && results) {
      ddata.devicestatus = _.map(results, function eachStatus (result) {
        result.mills = new Date(result.created_at).getTime();
        if ('uploaderBattery' in result) {
          result.uploader = {
            battery: result.uploaderBattery
          };
          delete result.uploaderBattery;
        }
        return result;
      }).reverse();
    } else {
      ddata.devicestatus = [];
    }
    callback();
  });
}

module.exports = init;