define([
	'dojo/has',
	'dojo/has!host-node?dojo/node!fs',
	'dojo/lang',
	'dojo/aspect',
	'dojo/Promise'
], function (has, fs, lang, aspect, Promise) {
	function noop() {}

	/**
	 * A Reporter that wraps a legacy reporter definition object.
	 */
	var LegacyReporter = (function () {
		// topics that don't directly map to reporter events
		var TOPIC_TO_EVENT = {
			'/test/new': 'newTest',
			'/suite/new': 'newSuite',
			'/client/end': 'runEnd',
			'/error': 'fatalError',
			'/runner/end': 'runEnd',
			'/runner/start': 'runStart',
			'/tunnel/stop': 'tunnelEnd',
			start: 'run',
			stop: 'destroy'
		};

		/**
		 * Converts a legacy Intern 2 reporter to an Intern 3 reporter instance.
		 */
		function LegacyReporter(reporterMap) {
			var callback;
			var eventName;

			// add all of the properties on the reporterMap that look like topics or map to a known
			// reporter method (e.g., start)
			for (var topicId in reporterMap) {
				callback = reporterMap[topicId];
				eventName = null;

				if (topicId in TOPIC_TO_EVENT) {
					eventName = TOPIC_TO_EVENT[topicId];
				}
				// programmatically transform legacy topic ID to event name
				else if (topicId.charAt(0) === '/') {
					eventName = topicId.slice(1).replace(/\/(\w)/g, function (_, firstLetter) {
						return firstLetter.toUpperCase();
					});
				}
				else {
					continue;
				}

				aspect.before(this, eventName, (function (callback) {
					return function () {
						return callback.apply(reporterMap, arguments);
					};
				})(callback));
			}
		}

		return LegacyReporter;
	})();

	/**
	 * A class that manages a set of reporters
	 *
	 * Standard events:
	 *     coverage
	 *     fatalError
	 *     newSuite
	 *     newTest
	 *     proxyEnd
	 *     proxyStart
	 *     runEnd
	 *     runStart
	 *     start
	 *     stop
	 *     suiteEnd
	 *     suiteError
	 *     suiteStart
	 *     testEnd
	 *     testPass
	 *     testSkip
	 *     testStart
	 *     tunnelDownloadProgress
	 *     tunnelEnd
	 *     tunnelStart
	 *     tunnelStatus
	 */
	function ReporterManager() {
		this._earlyEvents = [];
		this._reporters = [];
	}

	function defineLazyProperty(object, property, getter) {
		Object.defineProperty(object, property, {
			get: function () {
				var value = getter.apply(this, arguments);
				Object.defineProperty(object, property, {
					value: value,
					configurable: true,
					enumerable: true
				});
				return value;
			},
			configurable: true,
			enumerable: true
		});
	}

	ReporterManager.prototype = {
		constructor: ReporterManager,
		_earlyEvents: null,
		_reporters: null,

		/**
		 * Add a reporter to the list of managed reporters.
		 *
		 * @param {string} name event name to emit
		 */
		add: function (Reporter, config) {
			var reporter;

			if (typeof Reporter === 'object') {
				reporter = new LegacyReporter(Reporter);
			}
			else {
				config = Object.create(config);
				config.console = this._getConsole();

				if (has('host-node')) {
					/* jshint node:true */
					if (config.filename) {
						// Lazily create the writable stream so we do not open an extra fd for reporters that use
						// `filename` directly and never touch `config.output`
						defineLazyProperty(config, 'output', function () {
							return fs.createWriteStream(config.filename);
						});
					}
					else {
						var write = process.stdout.write.bind(process.stdout);
						config.output = {
							write: write,
							// Allow reporters to call `end` regardless of whether or not they are outputting to file,
							// without an error for stdout (which cannot be closed)
							end: write
						};
					}
				}
				else if (has('host-browser')) {
					defineLazyProperty(config, 'output', function () {
						var element = document.createElement('pre');

						return {
							write: function (chunk, encoding, callback) {
								element.appendChild(document.createTextNode(chunk));
								callback();
							},
							end: function (chunk, encoding, callback) {
								element.appendChild(document.createTextNode(chunk));
								document.body.appendChild(element);
								callback();
							}
						};
					});
				}

				reporter = new Reporter(config);
			}

			var reporters = this._reporters;
			reporters.push(reporter);

			return {
				remove: function () {
					this.remove = noop;
					lang.pullFromArray(reporters, reporter);
					return reporter.destroy && reporter.destroy();
				}
			};
		},

		empty: function () {
			this._reporters.forEach(function (reporter) {
				reporter.destroy && reporter.destroy();
			});
			this._reporters = [];
		},

		/**
		 * Emit an event to all registered reporters that can respond to it.
		 *
		 * @param {string} name event name to emit
		 * @returns {Promise.<void>}
		 */
		emit: function (name) {
			if (!this._reporters.length) {
				this._earlyEvents.push(Array.prototype.slice.call(arguments, 0));
				return Promise.resolve();
			}

			var args = Array.prototype.slice.call(arguments, 1);

			return Promise.all(this._reporters.map(function (reporter) {
				if (reporter[name]) {
					// In the case that a fatal error occurs and there are no reporters around that care,
					// the pre-executor will make a hail mary pass to try to get the information out by sending it to
					// the early error reporter if the error does not have a `reported` property
					if (name === 'fatalError' && args[0]) {
						args[0].reported = true;
					}

					return reporter[name].apply(reporter, args);
				}
			})).then(noop, noop);
		},

		_getConsole: function () {
			if (typeof console !== 'undefined') {
				return console;
			}

			var fakeConsole = {};

			[
				'assert',
				'count',
				'dir',
				'error',
				'exception',
				'info',
				'log',
				'table',
				'time',
				'timeEnd',
				'trace',
				'warn'
			].forEach(function (key) {
				fakeConsole[key] = noop;
			});

			return fakeConsole;
		},

		run: function () {
			var self = this;

			function emitEarlyEvents() {
				var promise = Promise.all(self._earlyEvents.map(function (event) {
					return self.emit.apply(self, event);
				}));
				self._earlyEvents.splice(0, Infinity);
				return promise.then(noop, noop);
			}

			return this
				.emit('run')
				.then(emitEarlyEvents);
		}
	};

	return ReporterManager;
});
