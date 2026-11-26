/* Preference pane wiring for Provenance: binds each input to its pref,
   plus strict/normal/lenient presets and reset-to-defaults. */
(function () {
	var BRANCH = 'extensions.provenance.';

	// [input id, pref name, type] - the single source of truth for the pane.
	var BINDS = [
		['ngram', 'ngram'],
		['minRunWords', 'minRunWords'],
		['excludeQuoted', 'excludeQuoted', 'bool'],
		['excludeBibliography', 'excludeBibliography', 'bool'],
		['citedSourcesOnly', 'citedSourcesOnly', 'bool'],
		['excludeDuplicates', 'excludeDuplicates', 'bool'],
		['nearMatchEnabled', 'nearMatchEnabled', 'bool'],
		['nearWatchPct', 'nearWatchPct'],
		['nearFlagPct', 'nearFlagPct'],
		['paraphraseEnabled', 'paraphraseEnabled', 'bool'],
		['paraContainPct', 'paraContainPct'],
		['maxParaphraseUnits', 'maxParaphraseUnits'],
		['maxBatch', 'maxBatch'],
		['flagThresholdPct', 'flagThresholdPct'],
		['watchThresholdPct', 'watchThresholdPct'],
		['sourceFlagPct', 'sourceFlagPct'],
		['sourceWatchPct', 'sourceWatchPct'],
		['maxPassages', 'maxPassages'],
		['useIndex', 'useIndex', 'bool'],
		['maxRefs', 'maxRefs'],
		['maxCompare', 'maxCompare'],
		['fetchOaPdf', 'fetchOaPdf', 'bool'],
		['autoOpenReport', 'autoOpenReport', 'bool'],
	];

	var DEFAULTS = {
		ngram: 8,
		minRunWords: 12,
		excludeQuoted: true,
		excludeBibliography: true,
		citedSourcesOnly: false,
		excludeDuplicates: true,
		nearMatchEnabled: true,
		nearWatchPct: 20,
		nearFlagPct: 40,
		paraphraseEnabled: true,
		paraContainPct: 65,
		maxParaphraseUnits: 40,
		maxBatch: 25,
		flagThresholdPct: 5,
		watchThresholdPct: 1,
		sourceFlagPct: 25,
		sourceWatchPct: 10,
		maxPassages: 6,
		useIndex: true,
		maxRefs: 200,
		maxCompare: 500,
		fetchOaPdf: false,
		autoOpenReport: true,
	};

	// Presets only override detection sensitivity; the rest stays default.
	// All values must be integers: Zotero.Prefs stores numbers by the
	// existing pref's type, and these prefs are int-typed, so a fractional
	// value like 0.5 is silently truncated to 0.
	var PRESETS = {
		strict: {
			flagThresholdPct: 2, watchThresholdPct: 0,
			sourceFlagPct: 15, sourceWatchPct: 5,
			nearWatchPct: 10, nearFlagPct: 25, paraContainPct: 55,
		},
		normal: {},
		lenient: {
			flagThresholdPct: 10, watchThresholdPct: 3,
			sourceFlagPct: 40, sourceWatchPct: 20,
			nearWatchPct: 35, nearFlagPct: 60, paraContainPct: 80,
		},
	};

	// A pref can be type-locked by an older default (e.g. an int pref that a
	// preset now wants to store 0.5 in). Zotero.Prefs.set throws on the type
	// mismatch and used to abort the whole preset mid-apply: Strict set the
	// thresholds before watchThresholdPct and silently dropped the rest.
	// Clear the locked pref and set it fresh.
	function setPref(name, v) {
		try { Zotero.Prefs.set(BRANCH + name, v, true); return; }
		catch (e) {
			try { Zotero.Prefs.clear(BRANCH + name, true); } catch (e2) {}
			Zotero.Prefs.set(BRANCH + name, v, true);
		}
	}

	function setInput(el, type, v) {
		if (type === 'bool') el.checked = !!v;
		else el.value = v;
	}

	function bind(id, name, type) {
		var el = document.getElementById(id);
		if (!el) return;
		var v = Zotero.Prefs.get(BRANCH + name, true);
		// A missing pref falls back to the built-in default, so a field
		// never renders empty.
		if (v === undefined) v = DEFAULTS[name];
		if (v !== undefined) setInput(el, type, v);
		el.addEventListener('change', function () {
			if (type === 'bool') {
				setPref(name, el.checked);
				syncPresetUI();
				return;
			}
			var val = Number(el.value);
			if (isNaN(val) || val < 0) return;
			setPref(name, val);
			syncPresetUI();
		});
	}

	function applyAll(values) {
		for (var i = 0; i < BINDS.length; i++) {
			var id = BINDS[i][0], name = BINDS[i][1], type = BINDS[i][2];
			var v = (name in values) ? values[name] : DEFAULTS[name];
			if (v === undefined) continue;
			setPref(name, v);
			var el = document.getElementById(id);
			if (el) setInput(el, type, v);
		}
	}

	function flash(msg) {
		var el = document.getElementById('preset-done');
		if (!el) return;
		el.textContent = msg;
		el.style.visibility = 'visible';
	}

	// The clicked preset keeps the highlight and the status line stays
	// visible, so a selection is clearly applied (previously the blue
	// "primary" style was hardcoded on Strict and the status vanished
	// after 2.5s, which read as "selecting does nothing").
	function markActive(name) {
		['strict', 'normal', 'lenient'].forEach(function (n) {
			var btn = document.getElementById('preset-' + n);
			if (btn) btn.classList.toggle('primary', n === name);
		});
	}

	// Name of the preset the current prefs match, or null for custom values.
	function currentPreset() {
		for (var name in PRESETS) {
			var match = true;
			for (var i = 0; i < BINDS.length; i++) {
				var prefName = BINDS[i][1];
				var expected = (prefName in PRESETS[name]) ? PRESETS[name][prefName] : DEFAULTS[prefName];
				var v = Zotero.Prefs.get(BRANCH + prefName, true);
				if (v === undefined) v = DEFAULTS[prefName];
				if (v !== expected) { match = false; break; }
			}
			if (match) return name;
		}
		return null;
	}

	function syncPresetUI(msg) {
		var m = currentPreset();
		markActive(m);
		flash(msg || (m ? 'Applied: ' + m : 'Custom settings'));
	}

	// Zotero loads the pane lazily, so the window's load event has usually
	// already fired by the time this script runs. Init immediately when
	// the pane elements are present; otherwise wait for them.
	function init() {
		if (init.done) return;
		if (!document.getElementById('ngram')) {
			// Zotero injects the pane fragment AFTER this script evaluates
			// (confirmed on Zotero 10: readyState is already 'complete' and
			// the elements arrive later), so neither DOMContentLoaded nor
			// load can save us. Poll briefly instead of never binding.
			init.tries = (init.tries || 0) + 1;
			if (init.tries < 40) setTimeout(init, 250);
			return;
		}
		init.done = true;
		for (var i = 0; i < BINDS.length; i++) bind(BINDS[i][0], BINDS[i][1], BINDS[i][2]);
		markActive(currentPreset());

		var p;
		for (var key in PRESETS) {
			(function (name) {
				var btn = document.getElementById('preset-' + name);
				if (btn) btn.addEventListener('click', function () {
					applyAll(PRESETS[name]);
					markActive(name);
					flash('Applied: ' + name);
				});
			})(key);
		}
		var reset = document.getElementById('preset-reset');
		if (reset) reset.addEventListener('click', function () {
			applyAll({});
			markActive('normal');
			flash('All settings reset to defaults');
		});

		var clearBtn = document.getElementById('clear-index');
		if (clearBtn) {
			clearBtn.addEventListener('click', function () {
				// Bump the epoch: every stored fingerprint becomes stale and
				// is rebuilt on the next check.
				Zotero.Prefs.set(BRANCH + 'indexEpoch', Date.now(), true);
				document.getElementById('clear-index-done').style.visibility = 'visible';
			});
		}
	}
	if (document.readyState == 'complete' || document.readyState == 'interactive') {
		init();
	}
	else {
		document.addEventListener('DOMContentLoaded', init);
		window.addEventListener('load', init);
	}
})();
