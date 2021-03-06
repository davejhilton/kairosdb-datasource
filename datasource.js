define([
  'angular',
  'lodash',
  'app/plugins/sdk',
  'app/core/utils/datemath',
  'app/core/utils/kbn',
  './query_ctrl'
],
function (angular, _, sdk, dateMath, kbn) {
  'use strict';

  var self;

  function KairosDBDatasource(instanceSettings, $q, backendSrv, templateSrv) {
    this.type = instanceSettings.type;
    this.url = instanceSettings.url;
    this.name = instanceSettings.name;
    this.supportMetrics = true;
    this.q = $q;
    this.backendSrv = backendSrv;
    this.templateSrv = templateSrv;

    self = this;
  }

  function expandTargets(options) {
    return _.flatten(_.map(
      options.targets,
      function(target) {
        return _.map(
          currentTemplateValue(target.metric, self.templateSrv, options.scopedVars),
          function(metric) {
            var copy = angular.copy(target);
            copy.metric = metric;
            return copy;
          }
        )
      }
    ));
  }

  // Called once per panel (graph)
  KairosDBDatasource.prototype.query = function(options) {
    var start = options.rangeRaw.from;
    var end = options.rangeRaw.to;

    var targets = expandTargets(options);
    var queries = _.compact(_.map(targets, _.partial(convertTargetToQuery, options)));
    var plotParams = _.compact(_.map(targets, function(target) {
      var alias = self.templateSrv.replace(target.alias);
      if (typeof target.alias === 'undefined' || target.alias === "") {
        alias = self.templateSrv.replace(target.metric);
      }

      if (!target.hide) {
        return { alias: alias, exouter: target.exOuter };
      }
      else {
        return null;
      }
    }));

    var handleKairosDBQueryResponseAlias = _.partial(handleKairosDBQueryResponse, plotParams);

    // No valid targets, return the empty result to save a round trip.
    if (_.isEmpty(queries)) {
      var d = this.q.defer();
      d.resolve({ data: [] });
      return d.promise;
    }

    return this.performTimeSeriesQuery(queries, start, end)
      .then(handleKairosDBQueryResponseAlias, handleQueryError);
  };

  KairosDBDatasource.prototype.performTimeSeriesQuery = function(queries, start, end) {
    var reqBody = {
      metrics: queries,
      cache_time: 0
    };

    convertToKairosTime(start, reqBody, 'start');
    convertToKairosTime(end, reqBody, 'end');

    var options = {
      method: 'POST',
      url: this.url + '/api/v1/datapoints/query',
      data: reqBody
    };

    return this.backendSrv.datasourceRequest(options);
  };

  /**
   * Gets the list of metrics
   * @returns {*|Promise}
   */
  KairosDBDatasource.prototype._performMetricSuggestQuery = function(metric) {
    var options = {
      url: this.url + '/api/v1/metricnames',
      method: 'GET'
    };

    return this.backendSrv.datasourceRequest(options).then(function(response) {
      if (!response.data) {
        return this.q.when([]);
      }
      var metrics = [];
      _.each(response.data.results, function(r) {
        if (r.indexOf(metric) >= 0) {
          metrics.push(r);
        }
      });
      return metrics;
    });
  };

  KairosDBDatasource.prototype._performMetricKeyLookup = function(metric, relativeStart) {
    if(!metric) { return this.q.when([]); }

    var options = {
      method: 'POST',
      url: this.url + '/api/v1/datapoints/query/tags',
      data: {
        metrics: [{ name: metric }],
        cache_time: 0,
        start_absolute: 0
      }
    };

    if (relativeStart) {
      delete options.data.start_absolute;
      options.data.start_relative = this.convertToKairosInterval(relativeStart);
    }

    return this.backendSrv.datasourceRequest(options).then(function(result) {
      if (!result.data) {
        return this.q.when([]);
      }
      var tagks = [];
      _.each(result.data.queries[0].results[0].tags, function(tagv, tagk) {
        if(tagks.indexOf(tagk) === -1) {
          tagks.push(tagk);
        }
      });
      return tagks;
    });
  };

  KairosDBDatasource.prototype._performMetricKeyValueLookup = function(metric, key, otherTags, relativeStart) {
    metric = metric.trim();
    key = key.trim();
    if(!metric || !key) {
      return this.q.when([]);
    }

    var metricsOptions = { name: metric };
    if (otherTags) {
      var tags = {};
      var kvps = otherTags.match(/\w+\s*=\s*(?:[^,{}]+|\{[^,{}]+(?:,\s*[^,{}]+)*\})/g);
      kvps.forEach(function(pair) {
        var kv = pair.split("=");
        var k = kv[0] ? kv[0].trim() : "";
        var value = kv[1] ? kv[1].trim() : "";
        if (value.search(/^\{.*\}$/) != -1) // multi-value, probably from a template var. e.g., "{dog,cat,bird}"
        {
          value = value.slice(1,-1).split(/\s*,\s*/);
        }
        if (k && value) {
          tags[k] = value;
        }
      });
      metricsOptions["tags"] = tags;
    }

    var options = {
      method: 'POST',
      url: this.url + '/api/v1/datapoints/query/tags',
      data: {
        metrics: [metricsOptions],
        cache_time: 0,
        start_absolute: 0
      }
    };

    if (relativeStart) {
      delete options.data.start_absolute;
      options.data.start_relative = this.convertToKairosInterval(relativeStart);
    }

    return this.backendSrv.datasourceRequest(options).then(function(result) {
      if (!result.data) {
        return this.q.when([]);
      }
      return result.data.queries[0].results[0].tags[key];
    });
  };

  KairosDBDatasource.prototype.metricFindQuery = function(query) {
    if (!query) { return this.q.when([]); }

    var interpolated;
    try {
      interpolated = this.templateSrv.replace(query);
    }
    catch (err) {
      return this.q.reject(err);
    }

    var responseTransform = function(result) {
      return _.map(result, function(value) {
        return {text: value};
      });
    };

    var metrics_regex = /metrics\((.*)\)/;
    var tag_names_regex = /tag_names\(\s*(.*?)\s*\)/;
    var tag_values_regex = /tag_values\(([^,]*),\s*([^,]*)(?:,\s*)?(\w+\s*=.*?)?\)/;
    var start_relative_regex = /start_relative\(\s*(\d+(?:\.\d+)?[Mwdhmsy]s?)\s*\)/

    var start_relative_match = interpolated.match(start_relative_regex);
    var start_relative = start_relative_match && start_relative_match[1] || undefined;

    var metrics_query = interpolated.match(metrics_regex);
    if (metrics_query) {
      return this._performMetricSuggestQuery(metrics_query[1]).then(responseTransform);
    }

    var tag_names_query = interpolated.match(tag_names_regex);
    if (tag_names_query) {
      return this._performMetricKeyLookup(tag_names_query[1], start_relative).then(responseTransform);
    }

    var tag_values_query = interpolated.match(tag_values_regex);
    if (tag_values_query) {
      return this._performMetricKeyValueLookup(tag_values_query[1], tag_values_query[2], tag_values_query[3], start_relative).then(responseTransform);
    }

    return this.q.when([]);
  };

  /////////////////////////////////////////////////////////////////////////
  /// Formatting methods
  ////////////////////////////////////////////////////////////////////////

  /**
   * Requires a verion of KairosDB with every CORS defects fixed
   * @param results
   * @returns {*}
   */
  function handleQueryError(results) {
    if (results.data.errors && !_.isEmpty(results.data.errors)) {
      var errors = {
        message: results.data.errors[0]
      };
      return self.q.reject(errors);
    }
    else {
      return self.q.reject(results);
    }
  }

  function handleKairosDBQueryResponse(plotParams, results) {
    var output = [];
    var index = 0;
    _.each(results.data.queries, function(series) {
      _.each(series.results, function(result) {
        var target = plotParams[index].alias;
        var details = " ( ";

        _.each(result.group_by, function(element) {
          if (element.name === "tag") {
            _.each(element.group, function(value, key) {
              details += key + "=" + value + " ";
            });
          }
          else if (element.name === "value") {
            details += 'value_group=' + element.group.group_number + " ";
          }
          else if (element.name === "time") {
            details += 'time_group=' + element.group.group_number + " ";
          }
        });

        details += ") ";

        if (details !== " ( ) ") {
          target += details;
        }

        var datapoints = [];

        for (var i = 0; i < result.values.length; i++) {
          var t = Math.floor(result.values[i][0]);
          var v = result.values[i][1];
          datapoints[i] = [v, t];
        }
        if (plotParams[index].exouter) {
          datapoints = new PeakFilter(datapoints, 10);
        }
        output.push({ target: target, datapoints: datapoints });
      });

      index++;
    });

    return { data: _.flatten(output) };
  }

  function currentTemplateValue(value, templateSrv, scopedVars) {
    var replacedValue;
    // Make sure there is a variable in the value
    if (templateSrv.variableExists(value)) {
      // Check to see if the value is just a single variable
      var fullVariableRegex = /^\s*(\$(\w+)|\[\[\s*(\w+)\s*\]\])\s*$/;
      var match = fullVariableRegex.exec(value);
      if (match) {
        var variableName = match[2] || match[3];
        if (scopedVars && scopedVars[variableName]) {
          replacedValue = scopedVars[variableName].value;
        } else {
          var variable = templateSrv.variables.find(function(v) { return v.name == variableName });
          if (variable.current.value == "$__all") {
            var filteredOptions = _.filter(variable.options, function(v) { return v.value != "$__all"; });
            replacedValue = _.map(filteredOptions, function(opt) { return opt.value; });
          } else {
            replacedValue = variable.current.value;
          }
        }
      } else {
        // The value isn't a full value match, try to use the template replace
        replacedValue = templateSrv.replace(value, scopedVars);
      }
    } else {
      // The value does not have a variable
      replacedValue = value;
    }
    return _.flatten([ replacedValue ]);
  }

  function convertTargetToQuery(options, target) {
    if (!target.metric || target.hide) {
      return null;
    }

    var metricName = currentTemplateValue(target.metric, self.templateSrv, options.scopedVars);
    var query = {
      name: metricName
    };

    query.aggregators = [];

    if (target.horizontalAggregators) {
      _.each(target.horizontalAggregators, function(chosenAggregator) {
        var returnedAggregator = {
          name:chosenAggregator.name
        };

        if (chosenAggregator.sampling_rate) {
          returnedAggregator.sampling = self.convertToKairosInterval(chosenAggregator.sampling_rate);
          returnedAggregator.align_sampling = true;
          //returnedAggregator.align_start_time = true;
        }

        if (chosenAggregator.unit) {
          returnedAggregator.unit = chosenAggregator.unit + 's';
        }

        if (chosenAggregator.factor && chosenAggregator.name === 'div') {
          returnedAggregator.divisor = chosenAggregator.factor;
        }
        else if (chosenAggregator.factor && chosenAggregator.name === 'scale') {
          returnedAggregator.factor = chosenAggregator.factor;
        }

        if (chosenAggregator.percentile) {
          returnedAggregator.percentile = chosenAggregator.percentile;
        }

        if (chosenAggregator.trim) {
          returnedAggregator.trim = chosenAggregator.trim;
        }

        query.aggregators.push(returnedAggregator);
      });
    }

    if (_.isEmpty(query.aggregators)) {
      delete query.aggregators;
    }

    if (target.tags) {
      query.tags = angular.copy(target.tags);
      _.forOwn(query.tags, function(value, key) {
        query.tags[key] = currentTemplateValue(value, self.templateSrv, options.scopedVars);
      });
    }

    if (target.groupByTags || target.nonTagGroupBys) {
      query.group_by = [];
      if (target.groupByTags) {
        query.group_by.push({
          name: "tag",
          tags: _.map(angular.copy(target.groupByTags), function(tag) { return self.templateSrv.replace(tag); })
        });
      }

      if (target.nonTagGroupBys) {
        _.each(target.nonTagGroupBys, function(rawGroupBy) {
          var formattedGroupBy = angular.copy(rawGroupBy);
          if (formattedGroupBy.name === 'time') {
            formattedGroupBy.range_size = self.convertToKairosInterval(formattedGroupBy.range_size);
          }
          query.group_by.push(formattedGroupBy);
        });
      }
    }
    return query;
  }

  ///////////////////////////////////////////////////////////////////////
  /// Time conversion functions specifics to KairosDB
  //////////////////////////////////////////////////////////////////////

  KairosDBDatasource.prototype.convertToKairosInterval = function(intervalString) {
    intervalString = self.templateSrv.replace(intervalString);

    var interval_regex = /(\d+(?:\.\d+)?)([Mwdhmsy])/;
    var interval_regex_ms = /(\d+(?:\.\d+)?)(ms)/;
    var matches = intervalString.match(interval_regex_ms);
    if (!matches) {
      matches = intervalString.match(interval_regex);
    }
    if (!matches) {
      throw new Error('Invalid interval string, expecting a number followed by one of "y M w d h m s ms"');
    }

    var value = matches[1];
    var unit = matches[2];
    if (value%1 !== 0) {
      if (unit === 'ms') {
        throw new Error('Invalid interval value, cannot be smaller than the millisecond');
      }
      value = Math.round(kbn.intervals_in_seconds[unit] * value * 1000);
      unit = 'ms';
    }

    return {
      value: value,
      unit: convertToKairosDBTimeUnit(unit)
    };
  };

  function convertToKairosTime(date, response_obj, start_stop_name) {
    var name;

    if (_.isString(date)) {
      if (date === 'now') {
        return;
      }
      else if (date.indexOf('now-') >= 0 && date.indexOf('/') === -1) {
        date = date.substring(4);
        name = start_stop_name + "_relative";
        var re_date = /(\d+)\s*(\D+)/;
        var result = re_date.exec(date);

        if (result) {
          var value = result[1];
          var unit = result[2];

          response_obj[name] = {
            value: value,
            unit: convertToKairosDBTimeUnit(unit)
          };
          return;
        }
        console.log("Unparseable date", date);
        return;
      }

      date = dateMath.parse(date, start_stop_name === 'end');
    }

    name = start_stop_name + "_absolute";
    response_obj[name] = date.valueOf();
  }

  function convertToKairosDBTimeUnit(unit) {
    switch (unit) {
    case 'ms':
      return 'milliseconds';
    case 's':
      return 'seconds';
    case 'm':
      return 'minutes';
    case 'h':
      return 'hours';
    case 'd':
      return 'days';
    case 'w':
      return 'weeks';
    case 'M':
      return 'months';
    case 'y':
      return 'years';
    default:
      console.log("Unknown unit ", unit);
      return '';
    }
  }

  function PeakFilter(dataIn, limit) {
    var datapoints = dataIn;
    var arrLength = datapoints.length;
    if (arrLength <= 3) {
      return datapoints;
    }
    var LastIndx = arrLength - 1;

    // Check first point
    var prvDelta = Math.abs((datapoints[1][0] - datapoints[0][0]) / datapoints[0][0]);
    var nxtDelta = Math.abs((datapoints[1][0] - datapoints[2][0]) / datapoints[2][0]);
    if (prvDelta >= limit && nxtDelta < limit) {
      datapoints[0][0] = datapoints[1][0];
    }

    // Check last point
    prvDelta = Math.abs((datapoints[LastIndx - 1][0] - datapoints[LastIndx - 2][0]) / datapoints[LastIndx - 2][0]);
    nxtDelta = Math.abs((datapoints[LastIndx - 1][0] - datapoints[LastIndx][0]) / datapoints[LastIndx][0]);
    if (prvDelta >= limit && nxtDelta < limit) {
      datapoints[LastIndx][0] = datapoints[LastIndx - 1][0];
    }

    for (var i = 1; i < arrLength - 1; i++) {
      prvDelta = Math.abs((datapoints[i][0] - datapoints[i - 1][0]) / datapoints[i - 1][0]);
      nxtDelta = Math.abs((datapoints[i][0] - datapoints[i + 1][0]) / datapoints[i + 1][0]);
      if (prvDelta >= limit && nxtDelta >= limit) {
        datapoints[i][0] = (datapoints[i - 1][0] + datapoints[i + 1][0]) / 2;
      }
    }

    return datapoints;
  }

  return KairosDBDatasource;
});
