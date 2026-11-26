/*
 * Provenance 8.9
 *
 * A plagiarism checker for your Zotero library, with reference fetching
 * built in. All checking is local: it reads only the PDFs and abstracts
 * already in the library, works fully offline, and calls no external
 * service for checking.
 *
 * For a selected paper (or a selected PDF, including standalone PDFs) it
 * measures, Turnitin-style:
 *   - an overall similarity score: the share of the paper's text that
 *     matches any checked source verbatim
 *   - per-source coverage in both directions: how much of the paper the
 *     source covers, and how much of the source is reused
 *   - matched passages merged into readable blocks with word counts,
 *     each annotated as properly cited or uncited
 *   - a side-by-side view pairing each paper passage with the matching
 *     text in the source
 *   - the whole paper highlighted by matching source in the HTML report
 *
 * Detection beyond verbatim copying, all computed locally:
 *   - near-match: stopword-insensitive, stemmed content-word grams catch
 *     lightly reworded text (articles swapped, verb forms changed)
 *   - paraphrase: sentence-level content-word containment against the
 *     text of matched sources flags rephrased sentences
 *   - PDF artifact cleanup: ligatures, soft hyphens, non-breaking spaces
 *     and smart punctuation are normalized before matching
 *
 * A batch mode cross-checks every paper in a collection against every
 * other and writes one summary page linking to each paper's report.
 *
 * Speed comes from a saved fingerprint index (provenance-index.json in the
 * Zotero data directory): unchanged sources are not re-read or re-hashed.
 * Duplicate copies of the paper or of a source (same DOI or normalized
 * title) are excluded from the score and listed in the report.
 *
 * Options live under Edit -> Settings -> Provenance.
 */


Provenance = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	addedElementIDs: [],
	_cfg: null,

	DEFAULTS: {
		flagThresholdPct: 5,
		watchThresholdPct: 1,
		sourceFlagPct: 25,
		sourceWatchPct: 10,
		ngram: 8,
		minRunWords: 12,
		maxRefs: 200,
		maxCompare: 500,
		maxPassages: 6,
		excludeQuoted: true,
		excludeBibliography: true,
		excludeDuplicates: true,
		citedSourcesOnly: false,
		autoOpenReport: true,
		fetchOaPdf: false,
		useIndex: true,
		indexEpoch: 4,
		nearMatchEnabled: true,
		nearWatchPct: 20,
		nearFlagPct: 40,
		paraphraseEnabled: true,
		paraContainPct: 65,
		maxParaphraseUnits: 40,
		maxBatch: 25,
	},

	// Menu and panel strings. Report documents stay English.
	STR: {
		en: {
			menuCheck: 'Plagiarism Check...',
			menuDraft: 'Check a Draft File (txt/md/tex/docx)...',
			menuFetch: 'Get References Only (online)...',
			menuSweep: 'Get References and Check (online)',
			menuBatch: 'Check Whole Collection...',
			working: 'Working...', done: 'Done', failed: 'Failed',
			cancel: 'Cancel', close: 'Close', cancelling: 'Cancelling...',
		},
		ar: {
			menuCheck: 'فحص الانتحال...',
			menuDraft: 'فحص مسودة من ملف (txt/md/tex/docx)...',
			menuFetch: 'جلب المراجع فقط (عبر الإنترنت)...',
			menuSweep: 'جلب المراجع وفحصها (عبر الإنترنت)',
			menuBatch: 'فحص المجموعة كلها...',
			working: 'جارٍ العمل...', done: 'تم', failed: 'فشل',
			cancel: 'إلغاء', close: 'إغلاق', cancelling: 'جارٍ الإلغاء...',
		},
	},
	_testLang: null,
	_lang() {
		if (this._testLang) return this._testLang;
		try {
			if (typeof Services !== 'undefined' && Services.locale) {
				let loc = Services.locale.appLocaleAsBCP47 || '';
				if (loc.toLowerCase().startsWith('ar')) return 'ar';
			}
		}
		catch (e) {}
		return 'en';
	},
	t(key) {
		let lang = this._lang();
		return (this.STR[lang] && this.STR[lang][key]) || this.STR.en[key] || key;
	},

	NEAR_NGRAM: 3,

	// Closed-class words carry no topical signal; dropping them (plus
	// numbers and very short tokens) before stemming makes reworded text
	// collapse onto the same gram stream as its source.
	STOPWORDS: new Set(('a an the and or but nor so yet of at by for with about into through during before after above below to from up down in out on off over under again further then once here there when where why how all both each few more most other some such no not only own same than too very can will just should now i me my we our you your he him his she her it its they them their this that these those am is are was were be been being have has had having do does did doing would could ought as if because until while between among within upon onto per via et al also thus hence therefore thereby however moreover furthermore whilst toward towards despite due ie eg vs'.split(' '))),

	INDEX_FILE: 'provenance-index.json',
	IGNORE_TAG: 'provenance:ignore',
	// Prior check results per paper, for the before/after comparison.
	HISTORY_FILE: 'provenance-history.json',
	HISTORY_MAX_PER_ITEM: 20,
	// How many matched sources get per-page passage lookup at most.
	PAGE_SOURCES_MAX: 8,
	// Online reference fetching: hard per-request timeout, attempts, backoff.
	HTTP_TIMEOUT_MS: 20000,
	HTTP_MAX_ATTEMPTS: 4,
	HTTP_BACKOFF_BASE_MS: 2000,
	INDEX_MAX_ENTRIES: 4000,
	INDEX_MAX_BYTES: 60 * 1024 * 1024,
	// Save the index every N newly-fingerprinted sources so a cancelled or
	// crashed first run keeps most of its work.
	INDEX_SAVE_EVERY: 25,
	PARA_MAX_SOURCE_UNITS: 100,
	PARA_MAX_SOURCES: 8,
	PARA_MAX_UNITS: 200,

	MERGE_GAP: 4,
	MAX_PASSAGE_CHARS: 400,
	SENT_EXPAND_BACK: 150,
	SENT_EXPAND_FWD: 200,
	// Paraphrase units: cap punctuation-less runs into overlapping windows
	// so a whole extracted page cannot pair as one giant "sentence", and
	// require coverage of the source window too (both directions).
	PARA_WINDOW_WORDS: 40,
	PARA_WINDOW_STEP: 20,
	PARA_MIN_SRC_COV: 0.25,
	// Highlighted paper view: excerpt context around each match.
	HL_CONTEXT_WORDS: 20,
	// A matched phrase found in at least this many checked sources counts
	// as common phrasing (boilerplate) rather than strong evidence.
	COMMON_DF_MIN: 3,
	COMMON_DF_FRAC: 0.3,
	COMMON_PASSAGE_FRAC: 0.6,
	TOP_PASSAGES: 10,
	// Both-directions coverage at or above this share means the source is
	// probably another version of the checked paper, not plagiarism.
	VERSION_OVERLAP: 0.8,
	// Base64 of icons/icon-32.png, embedded as the report favicon so
	// the saved HTML stays a single self-contained file. build.py
	// regenerates this line from the packaged icon on every build.
	REPORT_ICON_B64: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgEAYAAAAj6qa3AAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABmJLR0QAAAAAAAD5Q7t/AAAACXBIWXMAAAGAAAABgAAf5MsiAAAL1ElEQVRo3s2Ze1zUVfrH3+f7nWEGBhgY5KZpIF5RVMwkr1jmmqWZZuQlL2lqZqZmuv3Sfpa2qVtedjUvPwv7YW1seQmvKC3kLbTQBAUhCSHREAgF5Doz37N/zGTEmgLp7j6v18yZ18yc53yez3M53/McQSNlg/m+PmXbwGi2a6IvT5fn6ao0VZyViUziBCa8sKIiG6u3wVKBigailC8IxerWyX5MiZO9K5epp7WJrH9pc0qw2bvh6sRv/fC8V+S2wqFgPy3ek++7IJaQg3+3NXInYzk64JR4kE/p1cZLnJJfi7au76IBON/BdtcIcIiCggQRIEeLMH6orpHvMEUm5qwRk4mh/+FNcgKdyE8pUmbJLeLB6ktHl3llV8yC9CFxfYNn34SAqfMGTLiSDsKLeNEN5Dg6y4stL6JDwsIZDp9GmTGgIbw/otLpZ+UuershojltMDo/2QHK9jlsixO4YUcsXa4EyL2i+/nDVh9lhAyC6IKkL/yPgnh+beSKwilgHyQS5FLAn1r0LWuxIZDReVgRyIfb1FmwHnX/JfKzG5R63+uRiOPxCCRMWkI+RqxZycY9WpkyAcTUkgH9rxQB11Gx6z0dE9b6OhROz/6vM7SpxADw995UoqA9uwQjGkrVIB3F6LEBVaho4RewYEV9qhUKElFfwU3E7sh3+aiWxSGQQvuS84A75n/xxs3ESjUSRA/lOUJAzFfK6A+4OufLO5RiGgI5tB01KMi+legAmYBOhFOOK8hkzFRGpjkMt1y/redrqUGCiGQ4rhCyootR3xOaGQNPqhaQZvktObeYrzjoERPFVgLh8uW8cfaf4OKqrKHWamCcGIUKBNMNwx0gQkUiTB863Dqwj3iT7/FPQMdUfsQT8MSd6jbeDfIaQBXlSGCmWCrMMCBs+OtufhAR+vB4wxWgC9GE3GK+C3oAhhNPc0jrd9Zfux92L9rcsbwc8k6mdqjpCqwWpwm6g0R4YEcJGSvHEcZFdbrCeu6hTIQ7qrub5UaRa+QolomFNKuzUBpJBN1iTOEgQcBwatCBSe89S5kMvSZFGd0nQ1BO1w2GM8Bs2ZZc4HtOUwPOxGw0vhujHg3htoIulGNUjygyB4MDAgCWGxHQ2LGpxVKPEQFSaos4Dm6R5hfVPtBrdpTF/TkIynUSMddJRJ6TCNW5YtNwmhy7HKruBnCNxkl9Zn9vqTpEKoAs0NrJr8BNmgPU3tBLjYp1PwpyM3PZCnm+aVtrQoFrXKQW8MAHtenLKjcI+L1jUyWEexDg6+9dziQIHtTiS7EJgrYFJjEeOo0JjVBz4clvpz/qXgyW0/4/qokgC7SNpP9+3LomG3CniAh0VA7zH91nMRjMuMNg4Nlf/80tXtmv7ANjuOtMMR14ihmUAp9i+T386xod+j/LbVLAmmR9jV5Q9lzpx1omaEu1OfI44E/ATUP2a5KpBl2w7mnxAZjbeBUq/UDpoYxgZB39v1XcmkxAQ7e9+lK/uOjR142CfR13TakIgLh529Xrk4DrlHIIsOCNDrBixQZiPBN4FBRVGa2UgyHBNVjMhmlrXsj27AVdYsJxGQl440YIiJ7cIxYArYF10GT8Nwi4UxGg/VqT7z/8UlQvCAptnaJPAnlU200qoBetsIPoIwYIAdZr1jRbHpw9eWZa1gLI97j0QXoUlMSWppYvgvbvhcZ6+kLbb0JWth0L16dVvts6CESa+M60GRD00h4C7Ehqm0LAnaoBdux106B3db9i42qIWNf7R+NKkPfLqZhA1IiJfABlfUtHVjwMa61/fWnnu5C5KvuBeHco7VzavvQRuDSoYAEWSJyVZJQnweU1l3iXxeCTYDrRbiS0a+bTLmoweG02jmgTBXIKO7St9TD9WwlQfh2M2cEXRmkecGZL5muaEaRe6ogCXpBF9kpI8o8fGFsLcZt3zNkhwSPOo8a0HJ7uP7rj4Beh84awYSHtoORUyeqywXDw1IHFycmQ2TozMsMOtT1scz+cDeEjAz1mngKTwWVU4Asgn2Gbtt6JqwG23bkUEIi6CxakFBbIT+D8H74frV0AsV/5TrFAfmxuRGYY7P1od9WBUPBo4fGk6Qy85f32/8w4Co83Gz4o8gCoZnWO8hjQijk8BsN/eLxk4Ecwo+dzvmtehSzv7/eltYQfni39/8TV0OFB36wxHoAbzUQgUEGtLLi9GUqTn/zqj9qvUyBiWfdjqhEmp44N1y+GyZ3HbNDNAJ/t7tlnNaiaUNG39Af4Q/LgYw8MgscThh+J7AqqWQ1UXv5XoC0ymj/e/BnocK75Px7tBKqv6GM4DD99Veme8QbUetmvlueDGEsYhxuO+65tg/qr+hcYBc2w/BIYNihLuza3aBPgJ1rQHTrReUjrSFAT1OPKp7dY731S2ADuXi5tmvcAl1RV75ELtcH2rLI1YDXb51SUgeEJ1d28F9A4Kds1JAL+nU+COjB1dB/jGgEyUvaTM6HkkRL3srMNmDuMDswA2wHtZNU6sIfJlbUpoLwk+rmMAPUJ0UXvBXzHT2xvOO47R0ADiQhPCZ/X3gSGYoPO5c+Q8McDK45PgNwXL9guX/vtebZA2xFbCFzSl1YnT4HaQLssjwfPRQbZMhNcNulmmd8HNnJC+jWGgEJcsONsJtL0Y2YDD0P98yL3dH8DerpEJHbqCen56SNzlsKCN+Zv+yuQFJ2YlBIH+VPz1cKWcK5FxqoL82CdeM8acwy+3ZU1P0GCsl9JFI+B55fGzcHLQDWItYb9IAupJN1pj7wFXqe9OnGCNNFWfiMfo4PMqX7PWRwW3NaSJh6HLXMtn3segoWdXr9/8ml4ddeC4rXn4VjysZdO94LTid8eyTwLlv2Wd8ylUDW96vmaq1BysKSmdAtwQPiKCBBv8SfuhfzY0m2HXgHP9oa3Wm0Cv22mJ8JHgJzHPjoCJVTJc3UwKkioliKAavTa33SyFT1kBuBKGSLnZaoa2Og2YEIAMfIdWQ7Jf48fVN0actef62L9GGSGtpb0m8wzYsQAykVlUcs/QaRb6IpZQ6HmkytvH7gIV5aXfZUeAEURBS+XTQW1t7LGZSIEDPE4e58NPCcZC4L/Avmm0u2H5kKljzW70AzpDxXmxiwHVL+dfA5+T5l6dDsLMppTeAM12LgG6ABxIVK+QnsKbP8npqYNGHTlMlCDgtb3ZfypRbfHhA6JMC+5LRF2RzDJp7RLHAFp1I6TzW83Reu2tCQohUqxshHYrAzTVkNtiL2w/DJYu9t3VJSD8rUw6P3AIHVPmneDWiTeN+yFwrSKpacqIH1AYV7MMqiKtXYumgSuL+rzfDOg64CAomkdwDLVdVnHz0D2Z4v2TLUfReixj4rDFQ2xt3e9w9A3V3BBQ+zSOVpP428fCTrH2U7sVFrRDwRKFP0alg4/k6BNBEz4ikAwjFIHeh4Gw5tqqnk/sIKrfACsIVz6grzGnzVX8NtuGhH+BGDz+5ydkDGnMDcmESpfsaYWXoSrcVWrsmPA0tk1KPQLHK2wCQnX0SGxH/J1tABBLJjY53zxObi6VD/N7g20oAZ921f5CT32mM6Oi5EHxjXCpLsr0vnywVV0BBFFGIlQYquKyfSBq2OqVmRvhMBWHlkR94LbDr2738IzK+VK9mhZ48eTigdVqf6mPfZ2SkGd0jU+4qE1BRPAbbQ9UjkH2nQxS+5v70YZKvY3NzoCd9guR1/d7TOcMeK4OvsPkqFDjxeIz5iorASG0EH8rTqNjzkugxKy5TCitWmvX1ffls+L2NSJ1fcqzbVN8OGKpGEBnjep3Y+8FbX8vCe0mFHYynMDqI+wmqFuEfJDzFT06UAoFRgGLlJUmSC6thkiFfGwPOOqOpuMeqeau345Kh203yOK5SERWj2PgeI+mZM7Ty4jiOLExWIeP2I+vNhuJpoN5RmVFheTrRo+2X8wpMUbvyhq8HNc9P+Gdyyvhmarak/oFtLtYFef6Ovr1TcrlqjfaK3V3WRhogad4wLiLkaFdOK2oiBxcc3Rtop1Wuz940qPuS2y9a5MUr/Qwvh85vyT8z233F7dPwHAoKxSY811TwAAAABJRU5ErkJggg==',
	CITE_CONTEXT: 160,
	CITE_BEFORE: 140,

	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},

	log(msg) {
		try { Zotero.debug("Provenance: " + msg); } catch (e) {}
	},

	// Valid ranges for numeric settings. A setting outside its range (an
	// emptied field reads as 0 or an unexpected string) is clamped here,
	// because a phrase size of 0 would make every phrase hash equal and
	// "match" the whole library.
	CLAMPS: {
		ngram: [4, 20],
		minRunWords: [4, 60],
		maxRefs: [1, 1000],
		maxCompare: [1, 5000],
		maxPassages: [1, 20],
		maxBatch: [1, 200],
		flagThresholdPct: [1, 100],
		watchThresholdPct: [0, 100],
		sourceFlagPct: [1, 100],
		sourceWatchPct: [0, 100],
		nearWatchPct: [0, 100],
		nearFlagPct: [0, 100],
		paraContainPct: [1, 100],
		maxParaphraseUnits: [1, 200],
		indexEpoch: [0, 1e15],
	},

	cfg() {
		if (this._cfg) return this._cfg;
		let c = {};
		for (let k in this.DEFAULTS) {
			let v;
			try {
				v = Zotero.Prefs.get('extensions.provenance.' + k, true);
			}
			catch (e) {
				v = undefined;
			}
			if (v === undefined || v === null) v = this.DEFAULTS[k];
			if (typeof this.DEFAULTS[k] == 'boolean') {
				c[k] = (v === true || v === 'true');
			}
			else if (typeof this.DEFAULTS[k] == 'number') {
				let num = Number(v);
				if (!isFinite(num)) num = this.DEFAULTS[k];
				let clamp = this.CLAMPS[k];
				if (clamp) num = Math.min(clamp[1], Math.max(clamp[0], num));
				c[k] = num;
			}
			else {
				c[k] = v;
			}
		}
		this._cfg = c;
		return c;
	},

	addToWindow(window) {
		let doc = window.document;

		// One Provenance menu in each location (item context menu and
		// Tools), holding all actions, instead of five top-level entries
		// per menu. Item ids are unchanged from earlier versions.
		let mkItem = (id, label, onCommand) => {
			let mi = doc.createXULElement('menuitem');
			mi.id = id;
			mi.setAttribute('label', label);
			mi.addEventListener('command', onCommand);
			this.storeAddedElement(mi);
			return mi;
		};
		let buildMenu = (parent, suffix) => {
			let sep = doc.createXULElement('menuseparator');
			sep.id = 'provenance-sep-' + suffix;
			parent.appendChild(sep);
			this.storeAddedElement(sep);

			let menu = doc.createXULElement('menu');
			menu.id = 'provenance-menu-' + suffix;
			menu.setAttribute('label', 'Provenance');
			let popup = doc.createXULElement('menupopup');
			menu.appendChild(popup);

			popup.appendChild(mkItem('provenance-check-' + suffix, this.t('menuCheck'), () => {
				Provenance.console('clicked: Plagiarism Check');
				Provenance._run(window, w => Provenance.runCheckOnly(w));
			}));
			popup.appendChild(mkItem('provenance-draft-' + suffix, this.t('menuDraft'), () => {
				Provenance.console('clicked: Check a Draft File');
				Provenance._run(window, w => Provenance.runCheckDraft(w));
			}));
			popup.appendChild(mkItem('provenance-fetch-' + suffix, this.t('menuFetch'), () => {
				Provenance.console('clicked: Get References Only');
				Provenance._run(window, w => Provenance.runFetchOnly(w));
			}));
			popup.appendChild(mkItem('provenance-sweep-' + suffix, this.t('menuSweep'), () => {
				Provenance.console('clicked: Get References and Check');
				Provenance._run(window, w => Provenance.runSweep(w));
			}));
			popup.appendChild(mkItem('provenance-batch-' + suffix, this.t('menuBatch'), () => {
				Provenance.console('clicked: Check Whole Collection');
				Provenance._run(window, w => Provenance.runBatchCheck(w));
			}));

			parent.appendChild(menu);
			this.storeAddedElement(menu);
		};

		let itemMenu = doc.getElementById('zotero-itemmenu');
		if (itemMenu) buildMenu(itemMenu, 'itemmenu');

		let toolsMenu = doc.getElementById('menu_ToolsPopup');
		if (toolsMenu) buildMenu(toolsMenu, 'tools');

		// Plugin icon on every Provenance menu item.
		try {
			let iconURL = this.rootURI + 'icons/icon-16.png';
			for (let mi of doc.querySelectorAll('menuitem[id^="provenance-"]')) {
				mi.setAttribute('class', 'menuitem-iconic');
				mi.setAttribute('image', iconURL);
			}
		}
		catch (e) {}
	},

	addToAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) continue;
			this.addToWindow(win);
		}
	},

	storeAddedElement(elem) {
		if (!elem.id) throw new Error("Element must have an id");
		this.addedElementIDs.push(elem.id);
	},

	removeFromWindow(window) {
		let doc = window.document;
		for (let id of this.addedElementIDs) {
			doc.getElementById(id)?.remove();
		}
		doc.getElementById('provenance-progress-panel')?.remove();
	},

	removeFromAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) continue;
			this.removeFromWindow(win);
		}
	},

	error(window, e) {
		this.console("ERROR while " + (this._stage || 'working') + ": " + e + "\n" + (e && e.stack || ""));
		let msg = "Something went wrong while " + (this._stage || 'working') + ":\n" + (e && e.message || e);
		if (this._progress) this._progress.fail(msg);
		try {
			Services.prompt.alert(window, "Provenance", msg);
		}
		catch (e2) {}
		this._stage = null;
	},

	stage(s) {
		this._stage = s;
		this.console("stage: " + s);
		if (this._progress) this._progress.line(s + '...');
	},

	// ---------------------------------------------------------------
	// Engine self-test: proves the matching pipeline works
	// ---------------------------------------------------------------
	// Synthetic engine mini-check: builds two tiny in-memory texts and runs
	// the real tokenize/match/near/paraphrase paths. Returns one {name, pass,
	// detail} result per check; the test suite runs the same checks.
	selfTestEngine(cfg) {
		let results = [];
		let check = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });
		try {
			cfg = cfg || this.cfg();
			let srcRaw = 'The quick brown fox jumps over the lazy dog near the river bank today. '
				+ 'Transformers use attention mechanisms for language modelling tasks efficiently.';
			let paperRaw = 'Opening words here. The quick brown fox jumps over the lazy dog near '
				+ 'the river bank today. Closing words for the end of the passage.';
			let to = this.tokenizeDetailed(this.prepareText(paperRaw));
			to.gramHashes = this.gramHashArray(to.lwords, cfg.ngram);
			to.grams = new Set(to.gramHashes);
			to.gramCount = Math.max(1, to.gramHashes.length);
			let rto = this.tokenizeDetailed(this.prepareText(srcRaw));
			let hashes = this.gramsOf(rto.lwords, cfg.ngram);
			let m = this.matchSource(to, hashes, { year: '2020', authors: ['smith'] }, cfg, rto);
			check('verbatim matcher', m && m.paperPct > 0.2,
				m ? (m.paperPct * 100).toFixed(0) + '% of the test passage flagged' : 'no match at all');
			// Near-match path: stemmed content-word gram overlap, the same
			// primitives performCheck uses.
			let paperCw = new Set(this.gramsOf(this.contentStems(to.lwords), this.NEAR_NGRAM));
			let srcCw = this.gramsOf(this.contentStems(rto.lwords), this.NEAR_NGRAM);
			let cwHit = 0;
			for (let h of srcCw) if (paperCw.has(h)) cwHit++;
			check('near-match', cwHit > 0, cwHit + ' content-word grams overlap');
			// Paraphrase scorer with one synthetic matched source row.
			to.unionHashes = new Set(to.gramHashes);
			let prow = { title: 'Test source', srcText: this.prepareText(srcRaw), paperPct: 0.5, nearPct: 0 };
			let para = this.paraphraseLocal(to, [prow], cfg);
			check('paraphrase scorer', Array.isArray(para), para.length + ' paraphrase candidates');
			// PDF artifact cleanup: ligatures and line-break hyphenation.
			let cleaned = this.prepareText('hyphen-\nated \uFB03nal');
			check('artifact cleanup', cleaned.indexOf('hyphenated') >= 0 && cleaned.indexOf('ffinal') >= 0,
				'ligatures and split words normalized');
		}
		catch (e) {
			results.push({ name: 'engine self-test', pass: false, detail: String(e) });
		}
		return results;
	},


	async main() {
		this.log("Ready");
		this.console('v' + this.version + ' loaded');
	},

	// ---------------------------------------------------------------
	// Error Console logging, always on (unlike Zotero.debug, which
	// only prints when debug output is enabled)
	// ---------------------------------------------------------------
	console(msg) {
		try {
			if (!this._logLines) this._logLines = [];
			this._logLines.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
			if (this._logLines.length > 800) this._logLines.splice(0, this._logLines.length - 800);
			Services.console.logStringMessage("Provenance: " + msg);
		}
		catch (e) {}
	},

	// The run's full trace, saved next to the report for debugging.
	async saveLog(reportPath) {
		try {
			if (!this._logLines || !this._logLines.length) return '';
			let path = reportPath + '.log.txt';
			await Zotero.File.putContentsAsync(path,
				'Provenance ' + this.version + ' log - ' + new Date().toString() + '\n\n'
				+ this._logLines.join('\n') + '\n');
			return path;
		}
		catch (e) {
			return '';
		}
	},

	// ---------------------------------------------------------------
	// Visible loading panel, injected into the main window DOM (same
	// mechanism as the menu items, so it cannot fail to appear).
	// Adapter mimics ProgressWindow's ItemProgress (setText/
	// setProgress) plus line/done/fail. Every line also goes to the
	// Error Console. If injection fails, done/fail fall back to an
	// alert, so an outcome is never invisible.
	// ---------------------------------------------------------------
	openProgress(window, title) {
		let self = this;
		let adapter = {
			_doc: null,
			_els: null,
			_closed: false,
			_liveLi: null,
			setText(text) { self._progressAdd(this, text, true); },
			setProgress(pct) { self._progressBar(this, pct); },
			line(text) { self._progressAdd(this, text, false); },
			done(summary) { self._progressFinish(this, summary, false); },
			fail(msg) { self._progressFinish(this, msg, true); },
		};
		try {
			let doc = window.document;
			let old = doc.getElementById('provenance-progress-panel');
			if (old) old.remove();
			let mk = (tag, style, text) => {
				let el = doc.createElement(tag);
				if (style) el.style.cssText = style;
				if (text !== undefined) el.textContent = text;
				return el;
			};
			let panel = mk('div',
				'position:fixed;right:18px;bottom:18px;width:400px;max-height:70vh;'
				+ 'background:#f3f4f8;color:#1c1c28;border-radius:10px;'
				+ 'box-shadow:0 8px 30px rgba(0,0,0,.5);padding:14px 16px;'
				+ 'z-index:2147483647;font-family:system-ui,Segoe UI,Arial,sans-serif;'
				+ 'display:flex;flex-direction:column;');
			panel.id = 'provenance-progress-panel';
			let h = mk('div', 'font-size:14px;font-weight:700;color:#312e81;margin-bottom:2px;', title);
			let status = mk('div', 'font-size:11px;color:#6b7280;margin-bottom:8px;', this.t('working'));
			let bar = mk('div', 'height:6px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin-bottom:10px;flex:none;');
			let fill = mk('div', 'height:100%;width:0%;background:#4f46e5;border-radius:999px;transition:width .3s;');
			bar.appendChild(fill);
			let log = mk('div',
				'background:#fff;border-radius:8px;padding:8px 10px;font-size:11px;'
				+ 'line-height:1.6;overflow-y:auto;max-height:45vh;'
				+ 'box-shadow:inset 0 1px 3px rgba(0,0,0,.08);white-space:pre-wrap;');
			let cancelBtn = mk('button',
				'margin-top:10px;padding:5px 18px;border:0;'
				+ 'border-radius:6px;background:#dc2626;color:#fff;font-size:12px;'
				+ 'cursor:pointer;margin-right:8px;', this.t('cancel'));
			cancelBtn.addEventListener('click', () => {
				adapter.cancelled = true;
				cancelBtn.disabled = true;
				cancelBtn.style.opacity = '.5';
				status.textContent = this.t('cancelling');
				self.console('cancel requested by user');
			});
			let closeBtn = mk('button',
				'margin-top:10px;padding:5px 18px;border:0;'
				+ 'border-radius:6px;background:#4f46e5;color:#fff;font-size:12px;'
				+ 'cursor:pointer;display:none;', this.t('close'));
			closeBtn.addEventListener('click', () => {
				adapter._closed = true;
				panel.remove();
			});
			let btnRow = mk('div', 'display:flex;justify-content:flex-end;');
			btnRow.appendChild(cancelBtn);
			btnRow.appendChild(closeBtn);
			panel.appendChild(h);
			panel.appendChild(status);
			panel.appendChild(bar);
			panel.appendChild(log);
			panel.appendChild(btnRow);
			(doc.body || doc.documentElement).appendChild(panel);
			adapter._doc = doc;
			adapter._els = { panel, status, fill, log, closeBtn, cancelBtn };
			this.console('progress panel created');
		}
		catch (e) {
			this.console('PROGRESS PANEL FAILED TO APPEAR: ' + e);
		}
		this._progress = adapter;
		return adapter;
	},

	_progressAdd(adapter, text, replace) {
		this.console(text);
		let els = adapter._els;
		if (!els || adapter._closed) return;
		try {
			let li;
			if (replace && adapter._liveLi && adapter._liveLi.parentNode) {
				li = adapter._liveLi;
			}
			else {
				li = adapter._doc.createElement('div');
				els.log.appendChild(li);
			}
			adapter._liveLi = replace ? li : null;
			li.textContent = text;
			if (replace) els.status.textContent = text;
			els.log.scrollTop = els.log.scrollHeight;
		}
		catch (e) {
			this.console('panel update failed: ' + e);
		}
	},

	_progressBar(adapter, pct) {
		let els = adapter._els;
		if (!els || adapter._closed) return;
		try {
			els.fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
		}
		catch (e) {}
	},

	_progressFinish(adapter, msg, isFail) {
		this._progressAdd(adapter, msg, false);
		adapter._liveLi = null;
		let els = adapter._els;
		if (els && !adapter._closed) {
			try {
				els.status.textContent = isFail ? this.t('failed') : this.t('done');
				els.status.style.color = isFail ? '#dc2626' : '#059669';
				els.status.style.fontWeight = '700';
				els.fill.style.width = '100%';
				if (isFail) els.fill.style.background = '#dc2626';
				if (els.cancelBtn) els.cancelBtn.style.display = 'none';
				els.closeBtn.style.display = 'block';
			}
			catch (e) {}
		}
		else {
			// Panel unavailable: never let the outcome be invisible
			try {
				Services.prompt.alert(Zotero.getMainWindow(), "Provenance", msg);
			}
			catch (e) {}
		}
	},

	// ---------------------------------------------------------------
	// Mode 1: plagiarism check, with a scope choice
	// ---------------------------------------------------------------
	async runCheckOnly(window) {
		this._cfg = null;
		let cfg = this.cfg();

		let paper = this.selectPaperOrAlert(window);
		if (!paper) return;
		let item = paper.item;

		let prog = this.openProgress(window, "Provenance - Plagiarism Check");
		prog.line('Paper: "' + this.truncate(item.getField('title'), 60) + '"');

		let paperCols = (item.getCollections() || [])
			.map(id => Zotero.Collections.get(id))
			.filter(Boolean);
		let options = paperCols.map(c => "This paper's collection: " + c.name);
		let pickIdx = options.length;
		options.push("Choose a collection...");
		let libIdx = options.length;
		options.push("Entire library");

		let selected = {};
		let ok = Services.prompt.select(window, "Provenance - Plagiarism Check",
			"Check \"" + this.truncate(item.getField('title'), 60) + "\" against what?",
			options, selected);
		if (!ok) { prog.done('Cancelled.'); return; }

		let refItems, scopeLabel;
		if (selected.value < pickIdx) {
			let col = paperCols[selected.value];
			refItems = this.collectionItemsDeep(col);
			scopeLabel = 'Collection: ' + this.collPath(col) + ' (incl. subcollections)';
		}
		else if (selected.value == pickIdx) {
			let col = await this.pickCollection(window, item.libraryID, true);
			if (!col) { prog.done('Cancelled.'); return; }
			refItems = this.collectionItemsDeep(col);
			scopeLabel = 'Collection: ' + this.collPath(col) + ' (incl. subcollections)';
		}
		else {
			refItems = await Zotero.Items.getAll(item.libraryID);
			scopeLabel = 'Entire library';
		}
		prog.line('Scope: ' + scopeLabel);
		this.console('scope resolved: ' + scopeLabel + ', raw items: ' + refItems.length);

		refItems = refItems.filter(i => i && this._isUsableSource(i) && i.id != item.id);
		if (!refItems.length) {
			prog.done('There are no other papers in that scope to compare with.');
			return;
		}
		let capped = false;
		if (refItems.length > cfg.maxCompare) {
			refItems = refItems.slice(0, cfg.maxCompare);
			capped = true;
		}

		prog.setText("Checking against " + refItems.length + " items...");

		this.console('awaiting performCheck on ' + refItems.length + ' items');
		let results = await this.performCheck(item, refItems, prog, { attachment: paper.attachment });
		if (results.cancelled) {
			prog.done('Cancelled after ' + results.compared + ' of ' + results.total + ' sources. No report written.');
			return;
		}
		this.console('performCheck returned: ' + results.overallPct + '% overall, '
			+ results.flagged.length + ' flagged');

		let meta = { mode: 'check', scopeLabel: scopeLabel, capped: capped, totalRefs: refItems.length };
		this.stage('writing the report');
		let reportPath = await this.deliverReport(window, item, results, meta);
		this.console('report written: ' + reportPath);
		this.stage('saving the summary note');
		await this.attachSummaryNote(item, results, meta, reportPath);
		this.console('summary note attached');

		prog.done("Done: " + results.overallPct + "% overall similarity, "
			+ results.flagged.length + " sources flagged, " + results.uncitedPassages + " uncited passages."
			+ (cfg.autoOpenReport ? " Report opening in browser." : " Report saved."));
	},

	// Check a draft that is not in the library: pick a txt/md/tex/docx
	// file, read its text locally, and run the usual check against a
	// chosen scope. The draft gets a minimal item shim; nothing is
	// imported and no note is attached.
	async runCheckDraft(window) {
		this._cfg = null;
		let cfg = this.cfg();
		let { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
		let fp = new FilePicker();
		fp.init(window, 'Provenance - Check a draft file', fp.modeOpen);
		fp.appendFilter('Drafts (*.txt; *.md; *.tex; *.docx)', '*.txt; *.md; *.tex; *.docx');
		fp.appendFilters(fp.filterAll);
		if ((await fp.show()) != fp.returnOK) return;
		let path = fp.file.path || fp.file;
		let name = String(path).split(/[\\/]/).pop();
		let prog = this.openProgress(window, 'Provenance - Check Draft');
		prog.line('Draft: "' + name + '"');
		let text;
		try {
			text = await this.readDraftText(path);
		}
		catch (e) {
			this.log('draft read failed: ' + e);
			prog.done('Failed: could not read the draft file (' + e + ')');
			return;
		}
		if (/\.tex$/i.test(name)) text = this._texToText(text);
		if (!text || !text.trim()) {
			prog.done('Failed: no readable text in that file.');
			return;
		}
		this.console('draft text: ' + text.length + ' chars');
		let title = name.replace(/\.(txt|md|tex|docx)$/i, '');

		let options = ['Choose a collection...', 'Entire library'];
		let selected = {};
		let okSel = Services.prompt.select(window, 'Provenance - Check Draft',
			'Check "' + this.truncate(title, 60) + '" against what?', options, selected);
		if (!okSel) { prog.done('Cancelled.'); return; }
		let refItems, scopeLabel;
		if (selected.value == 0) {
			let col = await this.pickCollection(window, Zotero.Libraries.userLibraryID, true);
			if (!col) { prog.done('Cancelled.'); return; }
			refItems = this.collectionItemsDeep(col);
			scopeLabel = 'Collection: ' + this.collPath(col) + ' (incl. subcollections)';
		}
		else {
			refItems = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
			scopeLabel = 'Entire library';
		}
		prog.line('Scope: ' + scopeLabel);
		refItems = refItems.filter(i => i && this._isUsableSource(i));
		if (!refItems.length) {
			prog.done('There are no papers in that scope to compare with.');
			return;
		}
		let capped = false;
		if (refItems.length > cfg.maxCompare) {
			refItems = refItems.slice(0, cfg.maxCompare);
			capped = true;
		}

		let draftItem = {
			id: null,
			getField: f => f == 'title' ? title : '',
			getCreators: () => [],
		};
		let results = await this.performCheck(draftItem, refItems, prog, { rawText: text });
		if (results.cancelled) {
			prog.done('Cancelled after ' + results.compared + ' of ' + results.total + ' sources. No report written.');
			return;
		}
		let meta = { mode: 'draft', scopeLabel: scopeLabel + ' - draft file: ' + name, capped: capped, totalRefs: refItems.length };
		this.stage('writing the report');
		let reportPath = await this.deliverReport(window, draftItem, results, meta);
		this.console('report written: ' + reportPath);
		prog.done('Done: ' + results.overallPct + '% overall similarity, '
			+ results.flagged.length + ' sources flagged, ' + results.uncitedPassages + ' uncited passages.'
			+ (cfg.autoOpenReport ? ' Report opening in browser.' : ' Report saved.'));
	},

	// ---------------------------------------------------------------
	// Mode 2: fetch references -> collection -> check -> report
	// ---------------------------------------------------------------
	async runSweep(window) {
		this._cfg = null;
		let cfg = this.cfg();

		let paper = this.selectPaperOrAlert(window);
		if (!paper) return;
		let item = paper.item;

		let prog = this.openProgress(window, "Provenance - Fetch and Check");
		prog.line('Paper: "' + this.truncate(item.getField('title'), 60) + '"');

		let collection = await this.pickCollection(window, item.libraryID);
		if (!collection) { prog.done('Cancelled.'); return; }
		prog.line('Target collection: ' + collection.name);

		prog.setText("Fetching references...");
		let fetchTicker = this._startElapsedTicker(prog);
		let refs;
		try {
			refs = await this.fetchReferences(item, prog);
		}
		catch (e) {
			clearInterval(fetchTicker);
			if (e && e.cancelled) { prog.done('Cancelled.'); return; }
			prog.fail(e && e.message || String(e));
			this.console('fetch references failed: ' + (e && e.message || e));
			return;
		}
		clearInterval(fetchTicker);
		prog.setText("Found " + refs.length + " references. Importing...");
		prog.setProgress(15);

		let imp;
		try {
			imp = await this.importReferences(refs, collection, item.libraryID, prog);
		}
		catch (e) {
			if (e && e.cancelled) { prog.done('Cancelled.'); return; }
			prog.fail(e && e.message || String(e));
			return;
		}
		let { added, existing, oaFetched } = imp;
		prog.setText("Imported " + added + " (" + existing + " already there"
			+ (cfg.fetchOaPdf ? ", " + oaFetched + " PDFs downloaded" : "")
			+ "). Checking similarity...");
		prog.setProgress(40);

		let refItems = this.collectionItemsDeep(collection).filter(i => i.id != item.id);
		if (!refItems.length) {
			prog.done('There are no other papers in "' + collection.name + '" to compare with.');
			return;
		}
		let results = await this.performCheck(item, refItems, prog, { attachment: paper.attachment });
		if (results.cancelled) {
			prog.done('Cancelled after ' + results.compared + ' of ' + results.total + ' sources. No report written.');
			return;
		}

		let meta = {
			mode: 'sweep',
			scopeLabel: 'Collection: ' + collection.name,
			totalRefs: refs.length,
			added: added,
			existing: existing,
			oaFetched: oaFetched,
		};
		this.stage('writing the report');
		let reportPath = await this.deliverReport(window, item, results, meta);
		this.stage('saving the summary note');
		await this.attachSummaryNote(item, results, meta, reportPath);

		prog.done("Done: " + results.overallPct + "% overall similarity, "
			+ results.flagged.length + " sources flagged, " + results.uncitedPassages + " uncited passages."
			+ (cfg.autoOpenReport ? " Report opening in browser." : " Report saved."));
	},

	// ---------------------------------------------------------------
	// Mode: batch cross-check - every paper in a collection vs the rest
	// ---------------------------------------------------------------
	async runBatchCheck(window) {
		this._cfg = null;
		let cfg = this.cfg();

		let prog = this.openProgress(window, "Provenance - Collection Cross-Check");
		let libraryID = Zotero.Libraries.userLibraryID;
		let collection = await this.pickCollection(window, libraryID, true);
		if (!collection) { prog.done('Cancelled.'); return; }
		prog.line('Collection: ' + this.collPath(collection));

		let items = this.collectionItemsDeep(collection);
		if (items.length < 2) {
			prog.done('Need at least 2 papers in the collection to cross-check.');
			return;
		}
		let capped = false;
		if (items.length > cfg.maxBatch) {
			items = items.slice(0, cfg.maxBatch);
			capped = true;
		}
		this.stage('cross-checking ' + items.length + ' papers');

		let rows = [];
		let k = 0;
		for (let item of items) {
			k++;
			let title = item.getField('title') || '(untitled)';
			prog.setText('Checking ' + k + ' of ' + items.length + ': ' + this.truncate(title, 40));
			prog.setProgress(95 * k / items.length);
			let refs = items.filter(o => o.id != item.id);
			let results, reportPath = '';
			try {
				results = await this.performCheck(item, refs, prog, {});
				if (results.cancelled) {
					prog.done('Cancelled during paper ' + k + ' of ' + items.length
						+ '. The ' + rows.length + ' report(s) written so far are in the provenance-reports folder.');
					return;
				}
				let meta = { mode: 'batch', scopeLabel: 'Collection: ' + this.collPath(collection), totalRefs: refs.length };
				this.stage('writing report ' + k + ' of ' + items.length);
				reportPath = await this.deliverReport(window, item, results, meta, { open: false });
				await this.attachSummaryNote(item, results, meta, reportPath);
			}
			catch (e) {
				this.log('batch: failed on "' + title + '": ' + e);
				rows.push({ title: title, error: String(e) });
				continue;
			}
			rows.push({
				title: title,
				overallPct: parseFloat(results.overallPct),
				flagged: results.flagged.length,
				watch: results.watch.length,
				uncited: results.uncitedPassages,
				topSource: results.rows.length ? results.rows[0].title : '',
				topNear: results.rows.reduce((mx, r) => Math.max(mx, (r.nearPct || 0) * 100), 0),
				reportFile: reportPath ? reportPath.split(/[\\/]/).pop() : '',
			});
		}

		this.stage('writing the summary page');
		let dir = Zotero.getZoteroDirectory();
		dir.append('provenance-reports');
		await Zotero.File.createDirectoryIfMissingAsync(dir.path);
		let stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
		dir.append('collection-crosscheck_' + stamp + '.html');
		let html = this.buildBatchHTML(this.collPath(collection), rows, capped, items.length);
		await Zotero.File.putContentsAsync(dir.path, html);
		try { Zotero.launchFile(dir.path); } catch (e) { this.console('Could not open summary: ' + e); }

		prog.done('Done: cross-checked ' + items.length + ' papers. Summary opening in browser.');
	},

	buildBatchHTML(scopeLabel, rows, capped, count) {
		let cfg = this.cfg();
		let esc = s => this.escapeHTML(s);
		rows.sort((a, b) => (b.overallPct || 0) - (a.overallPct || 0));
		let body = rows.map((r, i) => {
			if (r.error) {
				return '<tr class="watch"><td>' + (i + 1) + '</td><td>' + esc(r.title)
					+ '<div class="meta">check failed: ' + esc(r.error) + '</div></td><td colspan="4">-</td><td>-</td></tr>';
			}
			let cls = (r.overallPct >= cfg.flagThresholdPct || r.flagged) ? 'flag'
				: ((r.overallPct >= cfg.watchThresholdPct || r.watch) ? 'watch' : 'ok');
			let link = r.reportFile ? '<a href="' + esc(r.reportFile) + '">' + esc(r.title) + '</a>' : esc(r.title);
			return '<tr class="' + cls + '"><td>' + (i + 1) + '</td><td>' + link + '</td>'
				+ '<td class="num">' + r.overallPct.toFixed(1) + '%</td>'
				+ '<td class="num">' + r.topNear.toFixed(0) + '%</td>'
				+ '<td class="num">' + r.flagged + '</td>'
				+ '<td class="num">' + r.uncited + '</td>'
				+ '<td>' + esc(r.topSource) + '</td></tr>';
		}).join('\n');
		return '<!DOCTYPE html><html><head><meta charset="utf-8">'
			+ '<link rel="icon" type="image/png" href="data:image/png;base64,' + this.REPORT_ICON_B64 + '">'
			+ '<title>Provenance - Collection Cross-Check</title>'
			+ '<style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1e293b}'
			+ 'h1{font-size:22px}table{width:100%;border-collapse:collapse;font-size:13px}'
			+ 'td,th{padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}'
			+ 'th{background:#f1f5f9;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b}'
			+ '.num{text-align:right;font-variant-numeric:tabular-nums}'
			+ '.meta{font-size:12px;color:#64748b}'
			+ 'tr.flag td:first-child{border-left:4px solid #dc2626}tr.watch td:first-child{border-left:4px solid #d97706}tr.ok td:first-child{border-left:4px solid #16a34a}'
			+ 'a{color:#4f46e5}</style></head><body>'
			+ '<h1>Collection cross-check</h1>'
			+ '<p class="meta">' + esc(scopeLabel) + ' &middot; ' + count + ' papers, each checked against the ' + (count - 1) + ' others'
			+ (capped ? ' &middot; capped at the first ' + count + ' items (raise the limit in Settings)' : '')
			+ ' &middot; ' + new Date().toLocaleString() + '</p>'
			+ '<p class="meta">Each paper links to its full report. Reuse between your own papers (self-plagiarism) shows up here as high scores.</p>'
			+ '<table><thead><tr><th>#</th><th>Paper</th><th>Verbatim</th><th>Best near-match</th><th>Flagged sources</th><th>Uncited passages</th><th>Top source</th></tr></thead>'
			+ '<tbody>' + body + '</tbody></table>'
			+ '<p class="meta">Generated by Provenance &middot; Ahmed Abdelmageed. All checks run locally; no text leaves this computer.</p>'
			+ '</body></html>';
	},

	// ---------------------------------------------------------------
	// Mode 3: fetch references into a chosen collection, no check
	// ---------------------------------------------------------------
	async runFetchOnly(window) {
		this._cfg = null;
		let cfg = this.cfg();

		let paper = this.selectPaperOrAlert(window);
		if (!paper) return;
		let item = paper.item;

		let prog = this.openProgress(window, "Provenance - Fetch References");
		prog.line('Paper: "' + this.truncate(item.getField('title'), 60) + '"');

		let collection = await this.pickCollection(window, item.libraryID);
		if (!collection) { prog.done('Cancelled.'); return; }
		prog.line('Target collection: ' + collection.name);

		prog.setText("Fetching references...");
		let ticker = this._startElapsedTicker(prog);
		let refs;
		try {
			refs = await this.fetchReferences(item, prog);
		}
		catch (e) {
			clearInterval(ticker);
			if (e && e.cancelled) { prog.done('Cancelled.'); return; }
			prog.fail(e && e.message || String(e));
			this.console('fetch references failed: ' + (e && e.message || e));
			return;
		}
		clearInterval(ticker);
		prog.setText("Found " + refs.length + " references. Importing...");
		prog.setProgress(30);

		let result;
		try {
			result = await this.importReferences(refs, collection, item.libraryID, prog);
		}
		catch (e) {
			if (e && e.cancelled) { prog.done('Cancelled.'); return; }
			prog.fail(e && e.message || String(e));
			return;
		}
		let { added, existing, oaFetched } = result;

		prog.done("Done: " + added + " new reference(s) added to \"" + collection.name + "\""
			+ " (" + existing + " already there"
			+ (cfg.fetchOaPdf ? ", " + oaFetched + " PDFs downloaded" : "") + ").");
	},

	// Keeps the panel visibly alive during a long network wait.
	_startElapsedTicker(prog) {
		if (!prog) return null;
		let t0 = Date.now();
		let base = '';
		return setInterval(() => {
			try {
				if (prog.cancelled) return;
				let s = Math.floor((Date.now() - t0) / 1000);
				if (prog._els && prog._els.status) {
					let cur = prog._els.status.textContent.replace(/ \(\d+s elapsed\)$/, '');
					prog._els.status.textContent = cur + ' (' + s + 's elapsed)';
				}
			}
			catch (e) {}
		}, 1000);
	},

	// Returns { item, attachment } for the current selection, or null.
	// A regular item is checked via its best attachment. A selected PDF
	// attachment is used directly: with a regular parent it checks the
	// parent but reads THIS pdf's text; a standalone PDF (no parent) is
	// checked as its own paper.
	getSelectedPaper(window) {
		let items = window.ZoteroPane.getSelectedItems();
		if (!items || !items.length) return null;
		let sel = items[0];
		if (!sel) return null;
		if (sel.isNote && sel.isNote()) return null;
		if (sel.isAttachment && sel.isAttachment()) {
			if (sel.attachmentContentType != 'application/pdf') return null;
			let parent = sel.parentItemID ? window.Zotero.Items.get(sel.parentItemID) : null;
			if (parent && parent.isRegularItem()) return { item: parent, attachment: sel };
			return { item: sel, attachment: sel };
		}
		if (!sel.isRegularItem()) return null;
		return { item: sel, attachment: null };
	},

	selectPaperOrAlert(window) {
		let paper = this.getSelectedPaper(window);
		if (!paper) {
			Services.prompt.alert(window, "Provenance",
				"Select a paper or a PDF file first.\n\nYou can select a normal library item, or a PDF directly - even a standalone PDF with no parent item. If you dragged a PDF into Zotero and want full metadata for it, right-click it and choose \"Create Parent Item\".");
		}
		return paper;
	},

	// A source we can compare against: a regular library item, or a
	// standalone PDF attachment (a PDF dragged into Zotero with no parent
	// item) - folders of lone PDFs are a normal way to keep sources.
	_isUsableSource(i) {
		try {
			if (i.isRegularItem && i.isRegularItem()) return true;
			return !!(i.isAttachment && i.isAttachment() && i.attachmentContentType == 'application/pdf');
		} catch (e) { return false; }
	},

	truncate(s, n) {
		s = s || '';
		return s.length > n ? s.slice(0, n - 1) + '...' : s;
	},

	// ---------------------------------------------------------------
	// Collection picker
	// ---------------------------------------------------------------
	async pickCollection(window, libraryID, checkOnlyLabel) {
		let cols = Zotero.Collections.getByLibrary(libraryID, true);
		if (!cols.length && checkOnlyLabel) {
			Services.prompt.alert(window, "Provenance", "This library has no collections.");
			return null;
		}
		let paths = cols.map(c => this.collPath(c));
		let order = paths.map((l, i) => i).sort((a, b) => paths[a].localeCompare(paths[b]));
		let labels = order.map(i => paths[i]);
		if (!checkOnlyLabel) labels.unshift("+ Create new collection...");
		let selected = {};
		let ok = Services.prompt.select(window, "Provenance", "Which collection?", labels, selected);
		if (!ok) return null;

		if (!checkOnlyLabel && selected.value == 0) {
			let name = { value: "References" };
			let okName = Services.prompt.prompt(window, "New collection", "Collection name:", name, null, {});
			if (!okName || !name.value.trim()) return null;
			let col = new Zotero.Collection();
			col.libraryID = libraryID;
			col.name = name.value.trim();
			await col.saveTx();
			return col;
		}
		return cols[order[selected.value - (checkOnlyLabel ? 0 : 1)]];
	},

	collectionDepth(col) {
		let d = 0;
		while (col.parentID) {
			d++;
			col = Zotero.Collections.get(col.parentID);
			if (!col) break;
		}
		return d;
	},

	// ---------------------------------------------------------------
	// Semantic Scholar reference fetching
	// ---------------------------------------------------------------
	async fetchReferences(item, prog) {
		let cfg = this.cfg();
		let doi = (item.getField('DOI') || '').trim();
		let title = item.getField('title') || '';
		let paperId = null;

		let byTitle = async () => {
			if (!title) throw new Error("The selected item has no DOI and no title to search by.");
			if (prog) prog.setText('Searching Semantic Scholar for "' + this.truncate(title, 40) + '"...');
			let search = await this.httpJSON(
				'https://api.semanticscholar.org/graph/v1/paper/search?limit=1&fields=title'
				+ '&query=' + encodeURIComponent(title), { prog });
			if (!search.data || !search.data.length) {
				throw new Error("Semantic Scholar could not find this paper by title.");
			}
			// Sanity-check the top hit: importing another paper's
			// references because the title search guessed wrong is worse
			// than failing loudly.
			let hit = search.data[0];
			if (!this._titlesMatch(title, hit.title || '')) {
				throw new Error('Semantic Scholar\'s top hit looks like a different paper ('
					+ this.truncate(hit.title || '?', 60) + '). Add the DOI to the item and try again.');
			}
			if (prog) prog.line('Found paper on Semantic Scholar.');
			return hit.paperId;
		};

		if (doi) {
			// The DOI keeps its slash: %2F in the path is rejected by the API.
			paperId = 'DOI:' + encodeURIComponent(doi).replace(/%2F/gi, '/');
		}
		else {
			paperId = await byTitle();
		}

		let fields = 'title,authors,year,externalIds,abstract,openAccessPdf';
		let url = 'https://api.semanticscholar.org/graph/v1/paper/' + paperId
			+ '/references?limit=' + cfg.maxRefs + '&fields=' + fields;
		if (prog) prog.setText('Fetching reference list (up to ' + cfg.maxRefs + ')...');
		let data;
		try {
			data = await this.httpJSON(url, { prog });
		}
		catch (e) {
			// A DOI the API does not know (404) falls back to the title.
			if (doi && title && /HTTP 404|does not know/.test(e && e.message || '')) {
				if (prog) prog.line('DOI not found on Semantic Scholar; trying the title.');
				paperId = await byTitle();
				url = 'https://api.semanticscholar.org/graph/v1/paper/' + paperId
					+ '/references?limit=' + cfg.maxRefs + '&fields=' + fields;
				data = await this.httpJSON(url, { prog });
			}
			else {
				throw e;
			}
		}
		let refs = [];
		for (let entry of (data.data || [])) {
			let p = entry.citedPaper;
			if (!p || !p.title) continue;
			refs.push({
				title: p.title,
				authors: (p.authors || []).map(a => a.name).filter(Boolean),
				year: p.year || null,
				doi: p.externalIds && p.externalIds.DOI ? p.externalIds.DOI : null,
				abstract: p.abstract || '',
				oaPdf: p.openAccessPdf && p.openAccessPdf.url ? p.openAccessPdf.url : null,
			});
		}
		refs = await this._cleanGarbledTitles(refs, prog);
		return refs;
	},

	// HTTP with our own timeout, cancellation, and retry/backoff on top of
	// Zotero.HTTP. Rationale: a single bare await on Zotero.HTTP.request
	// left the panel frozen at "fetching references" whenever Semantic
	// Scholar was slow or rate-limiting, and Cancel did nothing. Now every
	// request has a hard timeout we control, 429/5xx/network failures retry
	// with backoff, Cancel aborts the request, and failures come out as
	// clear messages.
	async httpJSON(url, opts) {
		opts = opts || {};
		let prog = opts.prog || null;
		let timeout = opts.timeout || this.HTTP_TIMEOUT_MS;
		let maxAttempts = opts.attempts || this.HTTP_MAX_ATTEMPTS;
		let lastErr = null;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			this._throwIfCancelled(prog);
			try {
				return await this._httpJSONOnce(url, timeout, prog);
			}
			catch (e) {
				if (e && e.cancelled) throw e;
				lastErr = e;
				let status = e && e.status;
				if (!status && e && e.message) {
					let m = /\b(\d{3})\b/.exec(e.message);
					if (m) status = parseInt(m[1]);
				}
				let retryable = status == 429 || (status >= 500 && status < 600)
					|| e.isTimeout || e.isNetwork || e.isEmpty;
				if (!retryable || attempt >= maxAttempts) break;
				let wait = Math.min(15000, this.HTTP_BACKOFF_BASE_MS * Math.pow(2, attempt - 1))
					+ (status == 429 ? 3000 : 0);
				this.console('HTTP ' + (status || 'error') + ' - retry ' + (attempt + 1)
					+ '/' + maxAttempts + ' in ' + wait + 'ms');
				if (prog) {
					prog.setText(status == 429
						? 'Semantic Scholar rate limit - retrying in ' + Math.ceil(wait / 1000)
							+ 's (attempt ' + (attempt + 1) + ' of ' + maxAttempts + ')...'
						: 'Request failed (' + this._httpBrief(e) + ') - retrying in '
							+ Math.ceil(wait / 1000) + 's (attempt ' + (attempt + 1) + ' of ' + maxAttempts + ')...');
				}
				await this._sleepCancellable(wait, prog);
			}
		}
		throw this._httpFriendlyError(lastErr);
	},

	// One request attempt with a hard timeout and cancel polling. The
	// Zotero.HTTP timeout stays as a backstop slightly above ours.
	async _httpJSONOnce(url, timeout, prog) {
		let cancelReq = null;
		let req = Zotero.HTTP.request('GET', url, {
			responseType: 'json',
			timeout: timeout + 5000,
			cancellerReceiver: (c) => { cancelReq = c; },
		});
		let timer = null, poll = null;
		try {
			let xhr = await new Promise((resolve, reject) => {
				timer = setTimeout(() => {
					try { cancelReq && cancelReq(); } catch (e) {}
					let e = new Error('Request timed out after ' + Math.round(timeout / 1000) + 's');
					e.isTimeout = true;
					reject(e);
				}, timeout);
				poll = prog ? setInterval(() => {
					if (prog.cancelled) {
						try { cancelReq && cancelReq(); } catch (e) {}
						let e = new Error('Cancelled');
						e.cancelled = true;
						reject(e);
					}
				}, 250) : null;
				req.then(resolve, reject);
			});
			let body = xhr.response || (xhr.responseText ? JSON.parse(xhr.responseText) : null);
			if (!body) {
				let e = new Error('Empty response from the API');
				e.isEmpty = true;
				throw e;
			}
			if (body.error) throw new Error('API error: ' + body.error);
			return body;
		}
		finally {
			if (timer) clearTimeout(timer);
			if (poll) clearInterval(poll);
		}
	},

	// Semantic Scholar citation-derived stub records carry the raw citation
	// string as their title: "Le , Ilya Sutskever , ... and Lukasz Kaiser .
	// Multitask sequence to sequence learning" (confirmed live against the
	// API). Detect the author-list shape (" , " separators, "and" before
	// the last name, " . " before the real title) and return the candidate
	// title, or null for a normal title. Real titles use "Name, Name"
	// without the leading space, so the spaced comma is the discriminator.
	// Short display title for the note lists: garbled citation-string
	// titles ("Le , Ilya Sutskever , ... . Real title") show as just the
	// real title fragment; anything else is truncated.
	shortNoteTitle(t) {
		let candidate = this._garbledCitationTitle(t);
		return this.truncate(candidate || (t || '(untitled)'), 70);
	},

	_garbledCitationTitle(title) {
		let m = /^(?:[^,|]{2,60} , ){1,12}(?:and )?[^,|]{2,60} \. (.{4,200})$/.exec(title || '');
		return m ? m[1].trim() : null;
	},

	// Replace garbled citation-string titles with the clean record found
	// by a title search, but only when the top hit really is the same
	// paper (_titlesMatch); otherwise keep the original. Rare (a stub or
	// two per reference list), so one extra request each is fine.
	async _cleanGarbledTitles(refs, prog) {
		let fields = 'title,authors,year,externalIds,abstract,openAccessPdf';
		let cleaned = 0;
		for (let ref of refs) {
			let candidate = this._garbledCitationTitle(ref.title);
			if (!candidate) continue;
			if (cleaned >= 15) break; // best-effort pass, never blocks the import
			cleaned++;
			try {
				// Pace these best-effort searches: anonymous Semantic Scholar
				// access is shared-rate-limited, and a burst here used to
				// 429-storm and stall the whole import for minutes.
				await this._sleepCancellable(700, prog);
				let url = 'https://api.semanticscholar.org/graph/v1/paper/search?limit=1&fields='
					+ fields + '&query=' + encodeURIComponent(candidate);
				// Cold Semantic Scholar searches regularly need more than 15s
				// (the warm retry returns in 1-2s), so the short timeout made
				// the first attempt fail and only the retry succeed.
				let data = await this.httpJSON(url, { prog, attempts: 2, timeout: 30000 });
				let hit = data && data.data && data.data[0];
				if (hit && hit.title && this._titlesMatch(candidate, hit.title)) {
					this.console('title cleanup: "' + this.truncate(ref.title, 60) + '" -> "' + hit.title + '"');
					ref.title = hit.title;
					ref.authors = (hit.authors || []).map(a => a.name).filter(Boolean);
					if (hit.year) ref.year = hit.year;
					if (hit.externalIds && hit.externalIds.DOI) ref.doi = hit.externalIds.DOI;
					if (hit.abstract) ref.abstract = hit.abstract;
					if (hit.openAccessPdf && hit.openAccessPdf.url) ref.oaPdf = hit.openAccessPdf.url;
				}
			}
			catch (e) {
				this.log('title cleanup failed for one reference: ' + e);
			}
		}
		return refs;
	},

	// Loose title agreement for the Semantic Scholar title-search top hit:
	// most content tokens of the shorter title must appear in the longer.
	_titlesMatch(a, b) {
		let tok = s => (this.normTitle(s || '').match(/[\p{L}\p{N}]+/gu) || [])
			.filter(w => w.length > 3 && !this.STOPWORDS.has(w));
		let ta = tok(a), tb = new Set(tok(b));
		if (!ta.length || !tb.size) return true;
		let have = ta.filter(w => tb.has(w)).length;
		return have / ta.length >= 0.6;
	},

	// Single-run guard: a second menu click during a check used to start
	// an overlapping run sharing one progress panel.
	async _run(window, fn) {
		if (this._busy) {
			Services.prompt.alert(window, 'Provenance', 'A Provenance check is already running. Wait for it to finish (or cancel it) first.');
			return;
		}
		this._busy = true;
		try {
			await fn(window);
		}
		catch (e) {
			this.error(window, e);
		}
		finally {
			this._busy = false;
		}
	},

	_throwIfCancelled(prog) {
		if (prog && prog.cancelled) {
			let e = new Error('Cancelled');
			e.cancelled = true;
			throw e;
		}
	},

	// Sleep in short slices so Cancel keeps working during backoff.
	async _sleepCancellable(ms, prog) {
		let end = Date.now() + ms;
		while (Date.now() < end) {
			this._throwIfCancelled(prog);
			await new Promise(r => setTimeout(r, Math.min(250, end - Date.now())));
		}
	},

	_httpBrief(e) {
		if (!e) return 'unknown error';
		if (e.isTimeout) return 'timeout';
		if (e.status) return 'HTTP ' + e.status;
		return String(e.message || e).slice(0, 60);
	},

	// Turn the last failure of a retry chain into a message the user can act on.
	_httpFriendlyError(e) {
		if (e && e.cancelled) return e;
		let status = e && e.status;
		if (e && e.isTimeout) {
			return new Error('Semantic Scholar did not answer in time after several attempts. '
				+ 'Check your internet connection and try again.');
		}
		if (status == 429) {
			return new Error('Semantic Scholar is rate-limiting requests right now (HTTP 429), '
				+ 'even after retries. Wait a few minutes and try again.');
		}
		if (status == 404) {
			return new Error('Semantic Scholar does not know this paper (HTTP 404). '
				+ 'Check that its DOI or title is correct.');
		}
		if (status) {
			return new Error('Semantic Scholar request failed (HTTP ' + status + ') after retries. '
				+ 'Try again later.');
		}
		return new Error('Could not reach Semantic Scholar (' + this._httpBrief(e)
			+ '). Check your internet connection and try again. Checking itself never needs the internet.');
	},

	// Run fn over items with a bounded number of concurrent workers.
	// Individual failures are logged and become null in the result array.
	async mapPool(items, size, fn, onProgress) {
		let results = new Array(items.length).fill(null);
		let next = 0, done = 0;
		let worker = async () => {
			while (next < items.length) {
				let i = next++;
				try {
					results[i] = await fn(items[i]);
				}
				catch (e) {
					this.log("Worker failed on item " + i + ": " + e);
				}
				done++;
				if (onProgress) onProgress(done);
			}
		};
		let workers = [];
		for (let k = 0; k < Math.min(size, items.length); k++) workers.push(worker());
		await Promise.all(workers);
		return results;
	},

	// ---------------------------------------------------------------
	// Import references into Zotero (optional OA PDF download)
	// ---------------------------------------------------------------
	async importReferences(refs, collection, libraryID, prog) {
		let cfg = this.cfg();
		let existingDOIs = new Set();
		for (let it of collection.getChildItems()) {
			let d = (it.getField && it.getField('DOI') || '').toLowerCase().trim();
			if (d) existingDOIs.add(d);
		}

		let added = 0, existing = 0, oaFetched = 0;
		let n = 0;
		for (let ref of refs) {
			this._throwIfCancelled(prog);
			n++;
			if (prog && (n % 10 == 0 || n == refs.length)) {
				prog.setText("Importing " + n + " of " + refs.length + "...");
			}
			if (ref.doi && existingDOIs.has(ref.doi.toLowerCase())) {
				existing++;
				continue;
			}
			let z = new Zotero.Item('journalArticle');
			z.libraryID = libraryID;
			z.setField('title', ref.title);
			if (ref.year) z.setField('date', String(ref.year));
			if (ref.doi) z.setField('DOI', ref.doi);
			if (ref.abstract) z.setField('abstractNote', ref.abstract);
			z.setCreators(ref.authors.map(name => {
				let parts = name.trim().split(/\s+/);
				let lastName = parts.pop() || name;
				return { creatorType: 'author', firstName: parts.join(' '), lastName: lastName };
			}));
			z.addToCollection(collection.id);
			try {
				await z.saveTx();
				if (ref.doi) existingDOIs.add(ref.doi.toLowerCase());
				added++;
			}
			catch (e) {
				this.log("Failed to save reference '" + ref.title + "': " + e);
				continue;
			}

			if (cfg.fetchOaPdf && ref.oaPdf) {
				try {
					// OA downloads can stall on dead hosts; give each one its
					// own timeout so one bad PDF cannot freeze the import.
					await Promise.race([
						Zotero.Attachments.importFromURL({
							url: ref.oaPdf,
							parentItemID: z.id,
							title: 'Full Text PDF',
						}),
						new Promise((_, rej) => setTimeout(() => rej(new Error('download timed out')), 45000)),
					]);
					oaFetched++;
				}
				catch (e) {
					this.log("OA PDF download failed for '" + ref.title + "': " + e);
				}
			}
		}
		return { added, existing, oaFetched };
	},

	// ---------------------------------------------------------------
	// Text extraction
	//
	// Zotero 10 removed Zotero.Fulltext.getItemContent(); its official
	// replacement is the attachmentText property, which reads the
	// .zotero-ft-cache file or extracts text on demand via PDFWorker.
	// attachmentText exists back through Zotero 7, so it is the primary
	// path everywhere; getItemContent is kept only as a fallback for old
	// versions.
	// ---------------------------------------------------------------
	async getItemFullText(item, attachment) {
		try {
			let att = attachment
				|| ((item.isAttachment && item.isAttachment()) ? item : await item.getBestAttachment());
			if (!att) return '';
			if (att.attachmentText !== undefined) {
				return (await att.attachmentText) || '';
			}
			if (Zotero.Fulltext && typeof Zotero.Fulltext.getItemContent == 'function') {
				await Zotero.Fulltext.indexItems([att.id], { complete: true });
				let { content } = await Zotero.Fulltext.getItemContent(att.id);
				return content || '';
			}
			return '';
		}
		catch (e) {
			this.log("Full-text extraction failed: " + e);
			return '';
		}
	},

	// ---------------------------------------------------------------
	// Plagiarism engine
	// ---------------------------------------------------------------
	// The dedup/bibliography key for a source: DOI first, else the
	// normalized title. One helper so duplicate filtering, bibliography
	// resolution and cited-sources-only filtering always agree.
	_sourceKey(doi, title) {
		let d = (doi || '').toLowerCase().trim();
		if (d) return 'd:' + d;
		let t = this.normTitle(title || '');
		return t ? 't:' + t : null;
	},

	// Cited-sources-only mode: keep just the sources the paper's
	// reference list resolved to. Answers "am I copying what I cite too
	// closely?" with far less noise than a whole-library pass.
	_citedOnlyFilter(keptItems, keepSet, safeField) {
		return keptItems.filter(ref => {
			let k = this._sourceKey(safeField(ref, 'DOI'), safeField(ref, 'title'));
			return k && keepSet.has(k);
		});
	},

	// Read a draft file from outside the library. txt/md/tex are plain
	// text; docx is a zip whose word/document.xml holds the document.
	// (nsIZipReader ships with the Zotero platform - the Zotero source
	// uses the same class for dictionaries and the reader.)
	async readDraftText(path) {
		if (/\.docx$/i.test(path)) {
			let zr = Components.classes['@mozilla.org/libjar/zip-reader;1']
				.createInstance(Components.interfaces.nsIZipReader);
			zr.open(Zotero.File.pathToFile(path));
			try {
				if (!zr.hasEntry('word/document.xml')) {
					throw new Error('word/document.xml missing - not a Word document');
				}
				let is = zr.getInputStream('word/document.xml');
				let cis = Components.classes['@mozilla.org/intl/converter-input-stream;1']
					.createInstance(Components.interfaces.nsIConverterInputStream);
				cis.init(is, 'UTF-8', 4096, 0xFFFD);
				let out = {};
				let xml = '';
				while (cis.readString(4096, out) != 0) { xml += out.value; out = {}; }
				cis.close();
				return this._docxXmlToText(xml);
			}
			finally { zr.close(); }
		}
		return await Zotero.File.getContentsAsync(path, 'utf-8');
	},

	_docxXmlToText(xml) {
		return xml
			.replace(/<w:tab\b[^>]*\/>/g, '\t')
			.replace(/<w:br\b[^>]*\/>/g, '\n')
			.replace(/<\/w:p>/g, '\n')
			.replace(/<[^>]+>/g, '')
			.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
			.replace(/&amp;/g, '&');
	},

	// Light LaTeX cleanup so commands and math delimiters do not poison
	// the word stream. Content inside braces of unknown commands is kept.
	_texToText(tex) {
		return tex
			.replace(/(?<!\\)%.*/g, '')
			.replace(/\\(?:section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/g, '\n$1\n')
			.replace(/\\(?:begin|end)\{[^}]*\}/g, '\n')
			.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ' ')
			.replace(/[{}$]/g, ' ')
			.replace(/\n{3,}/g, '\n\n');
	},

	// Index where the bibliography tail begins, or -1. Heading on its
	// own line (optionally numbered, several languages) past 40% of the
	// document; fallback: a run of numbered reference lines in the tail
	// for PDFs whose extraction lost the heading.
	_bibliographyCutIndex(text) {
		let re = /\n\s*(?:\d{1,2}[.\)]\s+|[IVX]{1,4}[.\)]\s+)?(references|bibliography|works cited|literature cited|reference list|références|referencias|referências|literaturverzeichnis|riferimenti|bibliografia|bibliografie|kaynakça|αναφορές|المراجع|参考文献)(?:\s+and\s+notes)?(?:\s*[\r\n]|[ \t]+(?=\[?\d{1,3}[.\]\)]))/giu;
		let m, cut = -1;
		while ((m = re.exec(text)) !== null) {
			if (m.index > text.length * 0.4) cut = m.index;
		}
		if (cut < 0) {
			let lines = text.split('\n');
			let pos = 0;
			let charIdx = lines.map(l => { let o = pos; pos += l.length + 1; return o; });
			let pat = /^\s*(\[\d{1,3}\]|\d{1,3}[.\)])\s+\S/;
			for (let i = Math.floor(lines.length * 0.4); i < lines.length; i++) {
				if (!pat.test(lines[i])) continue;
				if (charIdx[i] < text.length * 0.4) continue;
				let hits = 0, seen = 0;
				for (let j = i; j < lines.length && seen < 8; j++) {
					if (!lines[j].trim()) continue;
					seen++;
					if (pat.test(lines[j])) hits++;
				}
				if (hits >= 5) {
					let start = i;
					while (start > 0) {
						let k = start - 1;
						while (k > 0 && !lines[k].trim()) k--;
						if (pat.test(lines[k])) start = k; else break;
					}
					cut = charIdx[start];
					break;
				}
			}
		}
		return cut;
	},

	// The bibliography tail prepareText cuts away, or '' when none was
	// found. Numbered-citation resolution parses this to map [12] to a
	// reference-list entry. Works on the raw paper text; the cut rule is
	// the same one prepareText applies after normalization.
	extractBibliography(rawText) {
		if (!rawText) return '';
		let cut = this._bibliographyCutIndex(rawText);
		return cut > 0 ? rawText.slice(cut) : '';
	},

	// Parse a numbered bibliography tail into entries:
	// [{ num, raw, doi, year, firstAuthor, title }]. Entry starts are
	// "[12]", "12." or "12)" at line start; continuation lines join into
	// the open entry. Fields are best-effort: a DOI anywhere in the
	// entry, the first 4-digit year, the first surname-like token, and a
	// title from quotes, APA "(year). Title." form, or the text after
	// the author block.
	parseBibliography(tail) {
		let entries = [];
		if (!tail) return entries;
		// Some extractions join the whole bibliography into one paragraph
		// (single-column PDFs, Poppler paragraph merging). Put every inline
		// "[n]" entry marker on its own line so the line-start rule below
		// still finds it.
		tail = tail.replace(/([^\n])[ \t]+(?=\[\d{1,3}\]\s)/g, '$1\n');
		let startRe = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})[.\)])\s*(.*)$/;
		let cur = null;
		for (let line of tail.split('\n')) {
			let m = line.match(startRe);
			if (m) {
				if (cur) entries.push(cur);
				cur = { num: +(m[1] || m[2]), raw: m[3] || '' };
			} else if (cur) {
				cur.raw += ' ' + line.trim();
			}
		}
		if (cur) entries.push(cur);
		for (let e of entries) {
			let t = e.raw.replace(/\s+/g, ' ').trim();
			let dm = t.match(/10\.\d{4,9}\/[^\s,;"<>\]]+/i);
			e.doi = dm ? dm[0].replace(/[.,;)\]]+$/, '').toLowerCase() : '';
			let ym = t.match(/\b((?:19|20)\d{2})[a-z]?\b/);
			e.year = ym ? ym[1] : '';
			let am = t.match(/[A-Z\u00C0-\u00DE][\w'\u2019-]{1,30}/u);
			e.firstAuthor = am ? am[0].replace(/,$/, '') : '';
			e.title = this._biblioTitle(t, e.year);
		}
		return entries;
	},

	_biblioTitle(t, year) {
		let q = t.match(/[\u201C"`]([^\u201D"`]{10,200})[\u201D"']/);
		if (q) return q[1].trim();
		if (year) {
			// APA: "Author, A. (2017). Title of the work. Venue, ..."
			let m = t.match(new RegExp('\\(\\s*' + year + '[a-z]?\\s*\\)\\.?\\s*([^.]{10,200})\\.'));
			if (m) return m[1].trim();
		}
		// IEEE without quotes: skip author-like tokens (surnames,
		// initials, commas, "and", "&"), then take up to the next period.
		let m2 = t.match(/^((?:[A-Z][\w'\u2019-]{1,30}|(?:[A-Z]\.)+|and|&)[,.]?\s+)+([^ ].*?)\./u);
		if (m2 && m2[2].trim().length >= 10) return m2[2].trim();
		return '';
	},

	// Expand a numeric citation's bracket text into reference numbers:
	// "[12]" -> [12], "[3,4]" -> [3,4], "[3-7]" -> [3,4,5,6,7]. Range
	// expansion is capped so a malformed "[1-999]" cannot blow up.
	_citeNumbers(text) {
		let nums = new Set();
		let body = (text || '').replace(/[\[\]()]/g, ' ');
		for (let part of body.split(/[;,]/)) {
			let rm = part.trim().match(/^(\d{1,3})\s*[-\u2013]\s*(\d{1,3})$/);
			if (rm) {
				let a = +rm[1], b = +rm[2];
				if (b >= a && b - a <= 50) for (let i = a; i <= b; i++) nums.add(i);
				continue;
			}
			let sm = part.trim().match(/^(\d{1,3})$/);
			if (sm) nums.add(+sm[1]);
		}
		return [...nums];
	},

	// Resolve bibliography entries to library sources in scope. metas:
	// [{ key, doi, normTitle, year, authors }]. DOI first, then a title
	// match verified by _titlesMatch (year disambiguates), then
	// year + first-author surname. A match must be unique: an ambiguous
	// entry stays unresolved rather than guessing wrong.
	resolveBibliography(entries, metas) {
		let map = new Map();
		let resolved = 0;
		for (let e of entries) {
			let hit = null;
			if (e.doi) {
				let c = metas.filter(m => m.doi && m.doi == e.doi);
				if (c.length == 1) hit = c[0];
			}
			if (!hit && e.title && e.title.length >= 10) {
				let c = metas.filter(m => m.normTitle && this._titlesMatch(e.title, m.normTitle));
				if (c.length > 1 && e.year) {
					let cy = c.filter(m => m.year == e.year);
					if (cy.length) c = cy;
				}
				if (c.length == 1) hit = c[0];
			}
			if (!hit && e.year && e.firstAuthor) {
				let fa = e.firstAuthor.toLowerCase();
				let c = metas.filter(m => m.year == e.year
					&& m.authors.some(a => a && a.toLowerCase() == fa));
				if (c.length == 1) hit = c[0];
			}
			if (hit) { map.set(e.num, hit.key); resolved++; }
		}
		return { map: map, total: entries.length, resolved: resolved };
	},

	prepareText(text) {
		let cfg = this.cfg();
		// Normalize PDF extraction artifacts before tokenizing so the same
		// words hash the same no matter how the PDF renderer wrote them.
		text = text
			.replace(/\u00AD/g, '')          // soft hyphen
			.replace(/[\u00A0\u2007\u202F]/g, ' ') // no-break spaces
			.replace(/\uFB00/g, 'ff').replace(/\uFB01/g, 'fi')
			.replace(/\uFB02/g, 'fl').replace(/\uFB03/g, 'ffi')
			.replace(/\uFB04/g, 'ffl')
			.replace(/[\u2018\u2019]/g, "'")
			.replace(/[\u2013\u2014]/g, '-');
		// Join words split across PDF line breaks ("hyphen-\nated" -> "hyphenated")
		text = text.replace(/-\s*\n\s*/g, '');
		// Arabic normalization: tatweel (kashida) and harakat (diacritics)
		// carry no meaning for matching, and the alef variants are one
		// letter. Copies that differ only in vocalization or presentation
		// still match. Harmless for non-Arabic text.
		text = text
			.replace(/\u0640/g, '')                    // tatweel
			.replace(/[\u064B-\u0652\u0670]/g, '')     // harakat + superscript alef
			.replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627') // alef variants -> alef
			.replace(/\u0649/g, '\u064A');             // alef maksura -> yeh
		text = this._stripRepeatedLines(text);
		if (cfg.excludeBibliography) {
			let cut = this._bibliographyCutIndex(text);
			if (cut > 0) text = text.slice(0, cut);
		}
		if (cfg.excludeQuoted) {
			text = this._stripQuoted(text).text;
		}
		return text;
	},

	// Remove running headers, footers, page numbers and "Downloaded from"
	// boilerplate before hashing: any line repeated three or more times in
	// one document, plus pure page-number lines when a document has three
	// or more of them. Headers are a multi-page phenomenon, so documents
	// under ten lines are left alone, and stripping bails when it would
	// remove over 60% of the document's lines (pathological repeat).
	_stripRepeatedLines(text) {
		let lines = text.split('\n');
		if (lines.length < 10) return text;
		let counts = new Map();
		let numLines = 0;
		for (let l of lines) {
			let k = l.replace(/\s+/g, ' ').trim();
			if (k.length >= 4) counts.set(k, (counts.get(k) || 0) + 1);
			if (/^\s*\d{1,4}\s*$/.test(l)) numLines++;
		}
		let dropNums = numLines >= 3;
		let out = [], stripped = 0, nonEmpty = 0;
		for (let l of lines) {
			let k = l.replace(/\s+/g, ' ').trim();
			if (k) nonEmpty++;
			if (k.length >= 4 && counts.get(k) >= 3) { stripped++; continue; }
			if (dropNums && /^\s*\d{1,4}\s*$/.test(l)) { stripped++; continue; }
			out.push(l);
		}
		if (stripped > nonEmpty * 0.6) return text;
		return out.join('\n');
	},

	// Remove properly paired quoted spans of 20+ characters. Straight
	// quotes pair sequentially; curly and guillemet quotes pair with their
	// own closing form. The old single regex paired the CLOSING quote of a
	// short quote with the OPENING quote of the next one, deleting the
	// unquoted text between them (confirmed bug).
	_stripQuoted(text) {
		let closers = { '"': '"', '\u201C': '\u201D', '\u00AB': '\u00BB', '\u2018': '\u2019' };
		let out = '', pos = 0, quotedSpans = [];
		let re = /["\u201C\u00AB\u2018]/g, m;
		while ((m = re.exec(text)) !== null) {
			let end = text.indexOf(closers[m[0]], m.index + 1);
			if (end < 0) break;
			if (end - m.index - 1 >= 20) {
				out += text.slice(pos, m.index) + ' ';
				quotedSpans.push({ start: m.index, end: end + 1 });
				pos = end + 1;
			}
			re.lastIndex = end + 1;
		}
		out += text.slice(pos);
		return { text: out, quotedSpans };
	},

	// Crude suffix stripper for the near-match pass. Not a real stemmer:
	// it only unifies the most common English inflections, and refuses
	// stems under 4 characters so it never merges distinct short words.
	lightStem(w) {
		// English suffix rules only; other scripts (Arabic included) are
		// returned unchanged, which prepareText's normalization already
		// made consistent.
		if (!/^[\x00-\x7F]+$/.test(w)) return w;
		let rules = [
			/ization$/, /ational$/, /fulness$/, /ousness$/, /iveness$/,
			/tional$/, /bilities$/, /ingly$/, /ments$/, /ment$/,
			/ities$/, /ation$/, /ator$/, /alism$/, /aliti$/,
			/ous$/, /ive$/, /ful$/, /less$/, /ness$/, /able$/, /ible$/,
			/ing$/, /ies$/, /ied$/, /ed$/, /ly$/, /es$/, /s$/,
		];
		for (let re of rules) {
			if (re.test(w)) {
				let stem = w.replace(re, re.source == 'ies$' || re.source == 'ied$' ? 'y' : '');
				if (stem.length >= 4) return stem;
			}
		}
		return w;
	},

	// The content-word stream: lowercase tokens minus stopwords, numbers
	// and short tokens, each reduced by lightStem. Rewording that swaps
	// articles or verb forms leaves this stream (mostly) unchanged.
	contentStems(lwords) {
		let out = [];
		for (let w of lwords) {
			if (w.length < 3 || /^\d+$/.test(w) || this.STOPWORDS.has(w)) continue;
			out.push(this.lightStem(w));
		}
		return out;
	},

	// Tokenize keeping original case and character offsets (for display
	// and citation-context scanning). lwords is the lowercase form used
	// for matching.
	tokenizeDetailed(text) {
		let words = [], lwords = [], offsets = [];
		let re = /[\p{L}\p{N}]+/gu, m;
		while ((m = re.exec(text)) !== null) {
			if (m[0].length <= 1) continue;
			words.push(m[0]);
			lwords.push(m[0].toLowerCase());
			offsets.push(m.index);
		}
		return { words, lwords, offsets, text };
	},

	// Grams are compared as hashes instead of strings, so a source's
	// fingerprint can be cached compactly and matching runs on integers.
	// 8.5: the multiplication must be Math.imul - plain `h * 0x01000193`
	// exceeds 2^53 and rounds, so the old code was not FNV-1a at all
	// (every value differed, and 33% had their low three bits zero).
	// Two 32-bit FNV-1a passes with different bases are combined into one
	// exact 53-bit key, making a spurious 8-word hit from a collision
	// practically impossible (one in ~10^16 comparisons).
	hashGram(str) {
		let h = 0x811c9dc5;
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	},

	hashGram2(str) {
		let h = 0x9e3779b9;
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	},

	// 32 bits of hash 1 plus 21 bits of hash 2: max value is 2^53 - 1, the
	// largest exactly-representable integer.
	hashGramCombined(str) {
		return this.hashGram(str) * 0x200000 + (this.hashGram2(str) >>> 11);
	},

	gramHashArray(lwords, n) {
		let arr = new Array(Math.max(0, lwords.length - n + 1));
		for (let i = 0; i + n <= lwords.length; i++) {
			arr[i] = this.hashGramCombined(lwords.slice(i, i + n).join(' '));
		}
		return arr;
	},

	gramsOf(lwords, n) {
		return new Set(this.gramHashArray(lwords, n));
	},

	hashesToString(set) {
		let parts = [];
		for (let h of set) parts.push(h.toString(36));
		return parts.join(',');
	},

	stringToHashes(s) {
		let set = new Set();
		if (s) {
			for (let part of s.split(',')) set.add(parseInt(part, 36));
		}
		return set;
	},

	// ---------------------------------------------------------------
	// Saved fingerprint index (speed)
	// ---------------------------------------------------------------
	// The load is promise-cached: without this, a second caller during the
	// file read saw the empty placeholder and re-read (and lost) work.
	async loadIndex() {
		if (this._index) {
			// The clear-index button bumps the epoch; honor it even when the
			// index is already cached in memory.
			let want = this.cfg().indexEpoch || 0;
			if (this._index.epoch != want) {
				this._index = { epoch: want, entries: {} };
			}
			return this._index;
		}
		if (this._indexPromise) return this._indexPromise;
		this._indexPromise = (async () => {
			let epoch = this.cfg().indexEpoch || 0;
			let index = { epoch: epoch, entries: {} };
			try {
				let json = await Zotero.File.getContentsAsync(this._dataFilePath(this.INDEX_FILE));
				let data = JSON.parse(json);
				if (data && data.entries && data.epoch == epoch) {
					index = data;
				}
			}
			catch (e) {
				// No index yet, or unreadable: start empty
			}
			// Assign only when fully loaded: assigning an empty placeholder
			// first is the race this promise-caching is meant to close.
			this._index = index;
			return index;
		})();
		return this._indexPromise;
	},

	// The Zotero data directory as a path string. getZoteroDirectory()
	// still works but is deprecated; DataDirectory.dir is the modern path.
	_dataDirPath() {
		try {
			if (Zotero.DataDirectory && Zotero.DataDirectory.dir) return Zotero.DataDirectory.dir;
		}
		catch (e) {}
		return Zotero.getZoteroDirectory().path;
	},

	_dataFilePath(name) {
		let dir = this._dataDirPath();
		let sep = dir.includes('\\') ? '\\' : '/';
		return dir + (dir.endsWith('/') || dir.endsWith('\\') ? '' : sep) + name;
	},

	async saveIndex() {
		if (!this._index) return;
		try {
			// Entry cap plus a byte budget: prune least-recently-used
			// entries first. Entries carry `t` (ms) from when they were
			// cached; entries without it count as oldest.
			let entries = this._index.entries;
			let keys = Object.keys(entries);
			if (keys.length > this.INDEX_MAX_ENTRIES) {
				keys.sort((a, b) => (entries[a].t || 0) - (entries[b].t || 0));
				for (let k of keys.slice(0, keys.length - this.INDEX_MAX_ENTRIES)) delete entries[k];
			}
			let json = JSON.stringify(this._index);
			while (json.length > this.INDEX_MAX_BYTES) {
				let ks = Object.keys(entries).sort((a, b) => (entries[a].t || 0) - (entries[b].t || 0));
				if (ks.length <= 10) break;
				for (let k of ks.slice(0, Math.ceil(ks.length / 10))) delete entries[k];
				json = JSON.stringify(this._index);
			}
			// Atomic write: temp file, then move over the target, so a crash
			// mid-save cannot leave a truncated index.
			let path = this._dataFilePath(this.INDEX_FILE);
			let tmp = path + '.tmp';
			await Zotero.File.putContentsAsync(tmp, json);
			try {
				await IOUtils.move(tmp, path);
			}
			catch (e) {
				// No IOUtils (very old Zotero): plain write as before.
				await Zotero.File.putContentsAsync(path, json);
			}
		}
		catch (e) {
			this.log("Saving index failed: " + e);
		}
	},

	// Fingerprint one library source: its unique gram hashes, plus the
	// tokenized text when we had to read it anyway (or when asked for it).
	async getSourceFingerprint(ref, cfg, needText) {
		let abs = '';
		try { abs = ref.getField('abstractNote') || ''; } catch (e) {}
		let att = null;
		try {
			if (ref.isAttachment && ref.isAttachment()) {
				// A standalone PDF (no parent item) is its own attachment.
				att = ref.attachmentContentType == 'application/pdf' ? ref : null;
			}
			else {
				att = await ref.getBestAttachment();
			}
		} catch (e) {}

		let key, mod, basis, extract;
		if (att) {
			key = 'a' + att.id;
			// attachmentModificationTime tracks the PDF file itself; the item
			// record's dateModified does not change when only the file does.
			let mtime = '';
			try { mtime = String(await att.attachmentModificationTime || ''); } catch (e) {}
			mod = mtime || String(att.dateModified || '');
			basis = 'full text + abstract';
			extract = async () => {
				let full = await this.getItemFullText(ref);
				return [abs, full].filter(Boolean).join('\n');
			};
		}
		else {
			key = 'i' + ref.id;
			mod = String(ref.dateModified || '');
			basis = 'abstract only';
			extract = async () => abs;
		}

		let fromCache = false;
		let rto = null, hashes = null, cwHashes = null, unreadable = false;
		if (cfg.useIndex && !needText) {
			let index = await this.loadIndex();
			let entry = index.entries[key];
			// A cached entry made from very little text while a PDF is
			// attached means extraction failed when it was cached (for
			// example during the broken-reader versions): treat it as
			// stale and re-extract instead of trusting it forever.
			let staleShort = att && (entry && entry.len !== undefined && entry.len < 200);
			if (entry && entry.m === mod && entry.n === cfg.ngram && !staleShort) {
				hashes = this.stringToHashes(entry.h);
				cwHashes = this.stringToHashes(entry.c || '');
				fromCache = true;
			}
		}
		if (!hashes) {
			let text = await extract();
			if (!text.trim()) {
				// An attachment that yields no text is unreadable (corrupt,
				// encrypted or image-only) rather than simply empty.
				if (att) return { hashes: new Set(), cwHashes: new Set(), unreadable: true, basis, fromCache: false, att };
				return null;
			}
			rto = this.tokenizeDetailed(this.prepareText(text));
			hashes = this.gramsOf(rto.lwords, cfg.ngram);
			cwHashes = this.gramsOf(this.contentStems(rto.lwords), this.NEAR_NGRAM);
			if (cfg.useIndex) {
				let index = await this.loadIndex();
				index.entries[key] = { m: mod, n: cfg.ngram, len: rto.lwords.length, t: Date.now(),
					h: this.hashesToString(hashes), c: this.hashesToString(cwHashes) };
				this._indexDirty = (this._indexDirty || 0) + 1;
			}
		}
		return { hashes, cwHashes, rto, basis, fromCache, att };
	},

	mergePassages(matchedPos, to, n) {
		if (!matchedPos.length) return [];
		let runs = [];
		let start = matchedPos[0], last = matchedPos[0];
		for (let k = 1; k < matchedPos.length; k++) {
			let p = matchedPos[k];
			if (p - last <= this.MERGE_GAP) {
				last = p;
			}
			else {
				runs.push([start, last]);
				start = last = p;
			}
		}
		runs.push([start, last]);
		return runs.map(([a, b]) => {
			let wordStart = a, wordEnd = Math.min(to.words.length, b + n);
			// Display the match expanded to its sentence boundaries (bounded),
			// so a passage reads as full sentences instead of a clipped run.
			let rawStart = to.offsets[wordStart];
			let rawEnd = to.offsets[wordEnd - 1] + to.words[wordEnd - 1].length;
			let s = rawStart;
			let limit = Math.max(0, rawStart - this.SENT_EXPAND_BACK);
			let foundStart = false;
			while (s > limit) {
				if ('.!?'.includes(to.text[s - 1]) && /\s/.test(to.text[s] || '')) { foundStart = true; break; }
				s--;
			}
			if (!foundStart) s = rawStart;
			while (s < rawStart && /\s/.test(to.text[s])) s++;
			let e = rawEnd;
			let elimit = Math.min(to.text.length, rawEnd + this.SENT_EXPAND_FWD);
			while (e < elimit) {
				if ('.!?'.includes(to.text[e])) { e++; break; }
				e++;
			}
			let display = to.text.slice(s, e).replace(/\s+/g, ' ').trim();
			let truncated = false;
			if (display.length > this.MAX_PASSAGE_CHARS) {
				display = display.slice(0, this.MAX_PASSAGE_CHARS).replace(/\s+\S*$/, '');
				truncated = true;
			}
			return {
				text: display + (truncated ? ' ...' : ''),
				words: wordEnd - wordStart,
				wordStart: wordStart,
				wordEnd: wordEnd,
			};
		}).sort((x, y) => y.words - x.words);
	},

	// Number of distinct words covered by matched grams at the given
	// positions (ascending order). A run of L consecutive positions covers
	// L+n-1 words, not L: scoring by gram positions under-counts every run
	// by about n-1 words and disagrees with the highlighted text.
	coveredCount(sortedPos, n) {
		let covered = 0, end = -1;
		for (let p of sortedPos) {
			let s = p, e = p + n;
			if (s < end) s = end;
			if (e > s) covered += e - s;
			if (e > end) end = e;
		}
		return covered;
	},

	// A source counts only when it shares at least one run of
	// cfg.minRunWords or more with the paper; isolated n-gram hits are
	// reported as a collapsed "minor overlaps" count instead.
	isMinorMatch(m, cfg) {
		return (m.maxRunWords || 0) < (cfg.minRunWords || 0);
	},

	// Look just after a passage for an in-text citation.
	// Returns { found, text, year, author, numeric }
	findCitation(text, fromIdx) {
		let ctx = text.slice(fromIdx, fromIdx + this.CITE_CONTEXT);
		let m;

		// Numbered style: [12], [3,4], [3-5]
		m = ctx.match(/\[\s*\d+[\d\s,;\-\u2013]*\]/);
		if (m) return { found: true, text: m[0], numeric: true, year: null, author: null };

		// Narrative: Vaswani et al. (2017), Vaswani and Shazeer (2017),
		// Vaswani, Shazeer and Parmar (2017). Tried before the generic
		// parenthetical form so the authors are captured.
		m = ctx.match(/((?:[A-Z][A-Za-zÀ-ÿ'\-]{2,})(?:(?:,?\s+(?:and|&)\s+|,\s+)(?:[A-Z][A-Za-zÀ-ÿ'\-]{2,}))*(?:\s+et al\.?)?)\s*\(((?:19|20)\d{2}[a-z]?)\)/);
		if (m) return { found: true, text: m[0], numeric: false, year: m[2].slice(0, 4), author: m[1] };

		// Author-year, parenthetical: (Vaswani et al., 2017) or (2017)
		m = ctx.match(/\([^()]*?(?:19|20)\d{2}[a-z]?[^()]*?\)/);
		if (m) {
			let year = (m[0].match(/(?:19|20)\d{2}/) || [null])[0];
			let author = (m[0].match(/[A-Z][A-Za-zÀ-ÿ'\-]{2,}/) || [null])[0];
			return { found: true, text: m[0], numeric: false, year: year, author: author };
		}

		return { found: false, text: null, numeric: false, year: null, author: null };
	},

	// Narrative citations come BEFORE the passage ("Vaswani et al. (2017)
	// state that ..."); looking only after the passage marks those as
	// uncited and inflates the headline count. Take the last citation-like
	// match in the look-back window, the one closest to the passage.
	findCitationBefore(text, startIdx) {
		let ctx = text.slice(Math.max(0, startIdx - this.CITE_BEFORE), startIdx);
		let best = null, bestIdx = -1;
		let consider = (re, make) => {
			let m;
			while ((m = re.exec(ctx)) !== null) {
				if (m.index >= bestIdx) { bestIdx = m.index; best = make(m); }
			}
		};
		consider(/\[\s*\d+[\d\s,;\-\u2013]*\]/g,
			m => ({ found: true, text: m[0], numeric: true, year: null, author: null }));
		consider(/((?:[A-Z][A-Za-zÀ-ÿ'\-]{2,})(?:(?:,?\s+(?:and|&)\s+|,\s+)(?:[A-Z][A-Za-zÀ-ÿ'\-]{2,}))*(?:\s+et al\.?)?)\s*\(((?:19|20)\d{2}[a-z]?)\)/g,
			m => ({ found: true, text: m[0], numeric: false, year: m[2].slice(0, 4), author: m[1] }));
		consider(/\([^()]*?(?:19|20)\d{2}[a-z]?[^()]*?\)/g,
			m => ({
				found: true, text: m[0], numeric: false,
				year: (m[0].match(/(?:19|20)\d{2}/) || [null])[0],
				author: (m[0].match(/[A-Z][A-Za-zÀ-ÿ'\-]{2,}/) || [null])[0],
			}));
		return best || { found: false, text: null, numeric: false, year: null, author: null };
	},

	// 'cited' (author-year matching this source), 'nearby' (a citation is
	// present but not verifiably this source), 'none'. Author matching is
	// by substring so "Vaswani and Shazeer (2017)" matches Vaswani.
	citeStatus(cite, srcYear, srcAuthors, biblio, srcKey) {
		if (!cite.found) return 'none';
		if (cite.numeric) {
			// Numbered citation resolved through the paper's own reference
			// list: [12] -> entry -> library source. 'cited' when any cited
			// number resolves to this source, 'different' when every
			// resolved number points at another source (the useful signal:
			// the text came from A but the citation credits B). Entries
			// that did not resolve fall back to the old 'nearby'.
			if (biblio && biblio.map && srcKey) {
				let self = false, other = false;
				for (let num of this._citeNumbers(cite.text)) {
					let k = biblio.map.get(num);
					if (!k) continue;
					if (k == srcKey) self = true; else other = true;
				}
				if (self) return 'cited';
				if (other) return 'different';
			}
			return 'nearby';
		}
		let ctext = (cite.text || '').toLowerCase();
		let authorHit = srcAuthors.some(a => a && ctext.includes(a.toLowerCase()));
		if (authorHit) return 'cited';
		if (cite.year && srcYear && cite.year === String(srcYear)) return 'cited';
		return 'nearby';
	},

	// True when both-directions coverage says the source is another
	// version of the checked paper rather than plagiarism evidence.
	isProbableVersion(paperPct, reusePct) {
		return paperPct >= this.VERSION_OVERLAP && reusePct >= this.VERSION_OVERLAP;
	},

	// Credit each displayed passage to its earliest-dated source: when
	// several near-identical sources all contain the passage, showing five
	// rows at 40% each is noise - the provenance label names the first
	// appearance and lists the rest.
	attributePassages(passages, rows, n) {
		let sets = rows.filter(r => r.matchedPos && r.matchedPos.length)
			.map(r => ({ title: r.title, year: parseInt(r.year) || 9999, pos: new Set(r.matchedPos) }));
		for (let p of passages) {
			if (p.wordStart === undefined || p.wordEnd === undefined) continue;
			let holders = [];
			for (let s of sets) {
				let all = true, any = false;
				for (let g = p.wordStart; g + n <= p.wordEnd; g++) {
					if (s.pos.has(g)) any = true;
					else { all = false; break; }
				}
				if (all && any) holders.push(s);
			}
			if (holders.length < 2) continue;
			holders.sort((a, b) => a.year - b.year);
			let fmt = h => '"' + h.title + '"' + (h.year != 9999 ? ' ' + h.year : '');
			let also = holders.slice(1, 4).map(fmt).join(', ');
			p.provenance = 'first appears in ' + fmt(holders[0])
				+ (also ? '; also in ' + also : '')
				+ (holders.length > 4 ? ' and ' + (holders.length - 4) + ' more' : '');
		}
	},

	// Match one source against the paper. `to` is the tokenized paper with
	// gramHashes/grams precomputed; srcHashes is the source's unique gram
	// hash set; rto is the tokenized source text when available (used for
	// the source side of the side-by-side view); srcMeta { year, authors }.
	// Inverted index over source fingerprints: for each paper gram, the
	// sources containing it, plus per-source refHit/cwHit counts and the
	// matched paper positions in ascending order. One pass over all
	// fingerprints instead of one paper scan per source.
	buildPostings(to, fpList, cfg) {
		let postings = new Map();
		let srcInfo = [];
		for (let i = 0; i < fpList.length; i++) {
			let fp = fpList[i];
			srcInfo[i] = null;
			if (!fp || !fp.hashes || !fp.hashes.size) continue;
			let refHit = 0, cwHit = 0;
			for (let h of fp.hashes) {
				if (to.grams.has(h)) {
					refHit++;
					let arr = postings.get(h);
					if (!arr) postings.set(h, arr = []);
					arr.push(i);
				}
			}
			if (cfg.nearMatchEnabled && fp.cwHashes) {
				for (let h of fp.cwHashes) if (to.cwSet.has(h)) cwHit++;
			}
			srcInfo[i] = { refHit: refHit, cwHit: cwHit, matchedPos: [] };
		}
		for (let p = 0; p < to.gramHashes.length; p++) {
			let arr = postings.get(to.gramHashes[p]);
			if (!arr) continue;
			for (let i of arr) srcInfo[i].matchedPos.push(p);
		}
		return { postings: postings, srcInfo: srcInfo };
	},

	matchSource(to, srcHashes, srcMeta, cfg, rto) {
		let n = cfg.ngram;
		if (!srcHashes.size || to.lwords.length < n) return null;

		let matchedPos = [];
		for (let i = 0; i < to.gramHashes.length; i++) {
			if (srcHashes.has(to.gramHashes[i])) {
				matchedPos.push(i);
			}
		}
		if (!matchedPos.length) return null;

		let refHit = 0;
		for (let g of srcHashes) {
			if (to.grams.has(g)) refHit++;
		}
		return this.buildMatch(to, matchedPos, refHit, srcHashes.size, srcMeta, cfg, rto);
	},

	// Build the match result from precomputed matched positions (the
	// inverted-matching path in performCheck supplies them directly).
	buildMatch(to, matchedPos, refHit, srcCount, srcMeta, cfg, rto) {
		let n = cfg.ngram;
		if (!matchedPos.length) return null;

		let refPassages = [];
		let srcGramPos = null;
		if (rto) {
			let refMatchedPos = [];
			srcGramPos = new Map();
			for (let j = 0; j + n <= rto.lwords.length; j++) {
				let h = this.hashGramCombined(rto.lwords.slice(j, j + n).join(' '));
				if (!srcGramPos.has(h)) srcGramPos.set(h, j);
				if (to.grams.has(h)) {
					refMatchedPos.push(j);
				}
			}
			refPassages = this.mergePassages(refMatchedPos, rto, n);
		}

		let passages = this.mergePassages(matchedPos, to, n);

		// Citation analysis per passage: look after the passage first
		// (parenthetical style), then before it (narrative style).
		let uncited = 0;
		for (let p of passages) {
			let endChar = to.offsets[p.wordEnd - 1] + to.words[p.wordEnd - 1].length;
			let cite = this.findCitation(to.text, endChar);
			if (!cite.found) {
				cite = this.findCitationBefore(to.text, to.offsets[p.wordStart]);
			}
			p.cite = cite;
			p.citeStatus = this.citeStatus(cite, srcMeta.year, srcMeta.authors, srcMeta.biblio, srcMeta.key);
			if (p.citeStatus == 'none') uncited++;
		}

		// Pair paper-side and source-side passages by CONTENT: look up
		// where each paper passage's first shared gram lands in the source
		// and pair it with the source passage containing that position.
		// Rank pairing (k-th longest next to k-th longest) showed unrelated
		// passages side by side whenever the order differed.
		let pairs = [];
		let usedRef = new Set();
		for (let p of passages) {
			let match = -1;
			if (srcGramPos) {
				for (let g = p.wordStart; g + n <= p.wordEnd; g++) {
					let sp = srcGramPos.get(to.gramHashes[g]);
					if (sp === undefined) continue;
					let qi = refPassages.findIndex((q, i) =>
						!usedRef.has(i) && sp >= q.wordStart && sp < q.wordEnd);
					if (qi >= 0) { match = qi; break; }
				}
			}
			if (match >= 0) {
				usedRef.add(match);
				pairs.push({ paper: p, source: refPassages[match] });
			}
			else {
				pairs.push({ paper: p, source: null });
			}
		}
		for (let i = 0; i < refPassages.length; i++) {
			if (!usedRef.has(i)) pairs.push({ paper: null, source: refPassages[i] });
		}
		pairs = pairs.slice(0, cfg.maxPassages);

		return {
			paperPct: this.coveredCount(matchedPos, n) / Math.max(1, to.lwords.length),
			maxRunWords: passages.length ? passages[0].words : 0,
			reusePct: refHit / Math.max(1, srcCount),
			matchedCount: matchedPos.length,
			passages: passages.slice(0, cfg.maxPassages),
			uncited: uncited,
			pairs: pairs,
			matchedPos: matchedPos,
		};
	},

	async performCheck(item, refItems, prog, opts) {
		opts = opts || {};
		let cfg = this.cfg();
		let n = cfg.ngram;

		this.stage('reading the paper text');
		let originalText = (opts.rawText !== undefined) ? opts.rawText
			: await this.getItemFullText(item, opts.attachment);
		this.console('paper text: ' + (originalText || '').length + ' chars');
		let originalBasis = (opts.rawText !== undefined) ? 'full text (draft file)' : 'full text';
		if (!originalText) {
			let t = '', ab = '';
			try { t = item.getField('title') || ''; } catch (e) {}
			try { ab = item.getField('abstractNote') || ''; } catch (e) {}
			originalText = [t, ab].filter(Boolean).join('\n');
			originalBasis = 'title + abstract only (no indexed PDF found)';
		}
		let to = this.tokenizeDetailed(this.prepareText(originalText));
		to.gramHashes = this.gramHashArray(to.lwords, n);
		to.grams = new Set(to.gramHashes);
		to.gramCount = Math.max(1, to.gramHashes.length);
		// Content-word gram stream for the near-match (reworded text) pass.
		to.cwHashes = this.gramHashArray(this.contentStems(to.lwords), this.NEAR_NGRAM);
		to.cwSet = new Set(to.cwHashes);
		to.cwCount = Math.max(1, to.cwSet.size);

		let paperAuthors = [];
		try { paperAuthors = item.getCreators().map(c => (c.lastName || '').toLowerCase()); } catch (e) {}

		let rows = [];
		let allPassages = [];
		let unionMatched = new Set();
		let unionHashes = new Set();
		to.unionMatched = unionMatched;
		to.unionHashes = unionHashes;
		let compared = 0, noText = 0, indexHits = 0, indexMisses = 0;
		let minorOverlaps = 0;
		let df = new Map(); // matched gram -> how many sources contain it
		let noTextList = [];
		let knownTitles = new Set([this.normTitle(item.getField('title') || '')]);
		let knownDOIs = new Set();
		let paperDOI = '';
		try { paperDOI = (item.getField('DOI') || '').toLowerCase().trim(); } catch (e) {}
		let paperTitle = this.normTitle(item.getField('title') || '');
		if (paperDOI) knownDOIs.add(paperDOI);
		// A deleted or broken item must not abort the whole check: read its
		// fields defensively and skip it when they cannot be read.
		let safeField = (it, f) => {
			try { return (it.getField && it.getField(f)) || ''; } catch (e) { return ''; }
		};
		for (let it of refItems) {
			let t = this.normTitle(safeField(it, 'title'));
			if (t) knownTitles.add(t);
			let d = safeField(it, 'DOI').toLowerCase().trim();
			if (d) knownDOIs.add(d);
		}

		// Duplicates: a second copy of the checked paper, or a second copy
		// of a source already in the scope, is not plagiarism evidence.
		let duplicates = [];
		let seenSourceKeys = new Set();
		let keptItems = [];
		let ignoredTagged = [];
		let itemMetas = [];
		for (let ref of refItems) {
			let tags = [];
			try { tags = (ref.getTags ? ref.getTags() : []).map(x => (x && x.tag) || ''); } catch (e) {}
			if (tags.includes(this.IGNORE_TAG)) {
				ignoredTagged.push(safeField(ref, 'title') || '(untitled)');
				continue;
			}
			let d = safeField(ref, 'DOI').toLowerCase().trim();
			let t = this.normTitle(safeField(ref, 'title'));
			let key = this._sourceKey(d, safeField(ref, 'title'));
			let mAuthors = [];
			try { mAuthors = ref.getCreators().map(c => c.lastName || ''); } catch (e) {}
			itemMetas.push({ key: key, doi: d, normTitle: t, year: safeField(ref, 'date').slice(0, 4), authors: mAuthors });
			if (cfg.excludeDuplicates) {
				if ((paperDOI && d && d == paperDOI) || (paperTitle && t && t == paperTitle)) {
					duplicates.push({ title: safeField(ref, 'title') || '(untitled)', why: 'copy of the checked paper' });
					continue;
				}
				if (key && seenSourceKeys.has(key)) {
					duplicates.push({ title: safeField(ref, 'title') || '(untitled)', why: 'duplicate copy of another source' });
					continue;
				}
			}
			if (key) seenSourceKeys.add(key);
			keptItems.push(ref);
		}

		// Numbered citations: parse the paper's own reference list (the
		// bibliography tail the matcher cuts away) and resolve each entry
		// to a source in scope, so [12] can mean cited / cited a different
		// source / no citation instead of only "citation nearby".
		let biblio = { map: new Map(), total: 0, resolved: 0 };
		if (cfg.excludeBibliography) {
			let biblioEntries = this.parseBibliography(this.extractBibliography(originalText));
			biblio = this.resolveBibliography(biblioEntries, itemMetas);
			if (biblio.total) {
				this.console('bibliography: ' + biblio.total + ' entries, '
					+ biblio.resolved + ' resolved to sources in scope');
			}
		}

		// Cited-sources-only mode: compare just against the sources the
		// paper's reference list resolved to.
		let citedOnlyNote = '';
		if (cfg.citedSourcesOnly) {
			let before = keptItems.length;
			if (biblio.map.size) {
				keptItems = this._citedOnlyFilter(keptItems, new Set(biblio.map.values()), safeField);
				citedOnlyNote = 'Cited-sources-only mode: ' + keptItems.length + ' of ' + before
					+ ' sources in scope are in the paper\'s reference list.';
			} else {
				keptItems = [];
				citedOnlyNote = 'Cited-sources-only mode: no reference-list entries could be resolved, so no sources were compared.';
			}
			this.console(citedOnlyNote);
		}

		// ---- Library sources ----
		// Phase 1: read and fingerprint all sources, a few at a time, so
		// uncached sources don't serialize behind one another.
		let fps = [];
		if (keptItems.length) {
			this.stage('reading and fingerprinting ' + keptItems.length + ' source(s)');
			fps = await this.mapPool(keptItems, 4,
				(ref) => (prog && prog.cancelled) ? null : this.getSourceFingerprint(ref, cfg, false),
				(done) => {
					if (prog && done % 2 == 0) {
						prog.setText("Reading source texts: " + done + " of " + keptItems.length + "...");
						prog.setProgress(5 + 50 * done / Math.max(1, keptItems.length));
					}
				});
		}
		if (prog && prog.cancelled) {
			return { cancelled: true, compared: 0, total: keptItems.length };
		}

		// Phase 2a: count readable sources, then build the inverted
		// postings (paper gram -> sources) in one pass over all
		// fingerprints, replacing a full scan of the paper per source.
		for (let i = 0; i < keptItems.length; i++) {
			let fp = fps[i];
			if (!fp || !fp.hashes.size) {
				noText++;
				if (noTextList.length < 15) {
					noTextList.push((safeField(keptItems[i], 'title') || '(untitled)')
						+ (fp && fp.unreadable ? ' (unreadable: corrupt, encrypted or image-only PDF)' : ' (no readable text)'));
				}
				continue;
			}
			if (fp.fromCache) indexHits++; else indexMisses++;
			compared++;
			// Persist progress every INDEX_SAVE_EVERY newly-read sources, so a
			// cancelled or crashed first run keeps most of its work.
			if (cfg.useIndex && indexMisses && indexMisses % this.INDEX_SAVE_EVERY == 0) {
				await this.saveIndex();
			}
		}
		let cancelled = false;
		if (prog && prog.cancelled) cancelled = true;
		let srcInfo = [];
		if (!cancelled) {
			this.stage('matching ' + compared + ' source fingerprints');
			if (prog) {
				prog.setText('Matching ' + compared + ' source fingerprints...');
				prog.setProgress(60);
			}
			srcInfo = this.buildPostings(to, fps, cfg).srcInfo;
		}

		// Phase 2b: build rows for sources with evidence.
		let count = 0;
		for (let i = 0; !cancelled && i < keptItems.length; i++) {
			let info = srcInfo[i];
			if (!info) continue;
			count++;
			if (prog && count % 5 == 0) {
				prog.setText("Checking library sources: " + count + " of " + compared + "...");
				prog.setProgress(65 + 20 * count / Math.max(1, compared));
			}
			if (count % 25 == 0) await new Promise(r => setTimeout(r, 0));
			if (prog && prog.cancelled) { cancelled = true; break; }

			let ref = keptItems[i];
			let fp = fps[i];
			let srcYear = safeField(ref, 'date').slice(0, 4);
			let srcAuthors = [];
			try { srcAuthors = ref.getCreators().map(c => c.lastName || ''); } catch (e) {}
			let srcKey = this._sourceKey(safeField(ref, 'DOI'), safeField(ref, 'title'));
			let fpUsed = fp;

			// Near-match pass: how much of the paper's stemmed content-word
			// stream also appears in this source, with stopwords, numbers
			// and inflections collapsed. Catches lightly reworded copying
			// that verbatim n-grams miss. Kept out of the overall score.
			let nearPct = cfg.nearMatchEnabled ? info.cwHit / to.cwCount : 0;

			let m = null;
			if (info.matchedPos.length) {
				m = this.buildMatch(to, info.matchedPos, info.refHit, fp.hashes.size,
					{ year: srcYear, authors: srcAuthors, key: srcKey, biblio: biblio }, cfg, fp.rto);
				if (m && !fp.rto) {
					// Cached source matched: re-read its text once so the
					// side-by-side view has the source's own passages.
					let fp2 = await this.getSourceFingerprint(ref, cfg, true);
					if (fp2 && fp2.rto) {
						let mp = [];
						for (let p = 0; p < to.gramHashes.length; p++) {
							if (fp2.hashes.has(to.gramHashes[p])) mp.push(p);
						}
						m = this.buildMatch(to, mp, info.refHit, fp2.hashes.size,
							{ year: srcYear, authors: srcAuthors, key: srcKey, biblio: biblio }, cfg, fp2.rto);
						fpUsed = fp2;
					}
				}
			}

			// Minimum run length: a source with only isolated short overlaps
			// (no run of cfg.minRunWords+ words) is not counted as overlap;
			// it still qualifies for the reworded-only listing below.
			if (m && this.isMinorMatch(m, cfg)) {
				minorOverlaps++;
				m = null;
			}

			let sharedAuthor = srcAuthors.some(a => a && paperAuthors.includes(a.toLowerCase()));
			let rowTitle = safeField(ref, 'title') || '(untitled)';
			// Keep the source's original text (punctuation intact) for
			// sentence-level features; a punctuation-stripped word join made
			// every source one giant "sentence".
			let rowSrcText = fpUsed.rto ? fpUsed.rto.text : safeField(ref, 'abstractNote');
			if (!m) {
				// No verbatim overlap, but enough reworded overlap to list
				// the source as a near-match for manual review.
				if (nearPct * 100 >= cfg.nearWatchPct) {
					rows.push({
						title: rowTitle, year: srcYear,
						doi: safeField(ref, 'DOI').trim(),
						sharedAuthor: sharedAuthor,
						paperPct: 0, reusePct: 0, matchedCount: 0,
						matchedPos: [], passages: [], pairs: [], uncited: 0,
						nearPct: nearPct, nearOnly: true,
						basis: fp.basis + ' - reworded text only',
						srcText: rowSrcText,
					});
				}
				continue;
			}

			// Probable version: when the source covers almost all of the
			// paper AND the paper covers almost all of the source, it is
			// another version of the same work (preprint, published copy,
			// thesis chapter) - collapse it like a duplicate, do not count
			// it as plagiarism evidence. Both directions are required, so a
			// fully-quoted abstract never qualifies.
			if (this.isProbableVersion(m.paperPct, m.reusePct)) {
				duplicates.push({ title: rowTitle, why: 'probable version of the checked paper' });
				continue;
			}

			for (let p of m.matchedPos) {
				unionMatched.add(p);
				unionHashes.add(to.gramHashes[p]);
				df.set(to.gramHashes[p], (df.get(to.gramHashes[p]) || 0) + 1);
			}
			let row = {
				title: rowTitle,
				year: srcYear,
				doi: safeField(ref, 'DOI').trim(),
				sharedAuthor: sharedAuthor,
				paperPct: m.paperPct,
				reusePct: m.reusePct,
				matchedCount: m.matchedCount,
				matchedPos: m.matchedPos,
				passages: m.passages,
				pairs: m.pairs,
				uncited: m.uncited,
				nearPct: nearPct,
				basis: fp.basis,
				srcText: rowSrcText,
				att: fp.att || null,
			};
			rows.push(row);
		}

		if (cancelled) {
			return { cancelled: true, compared: compared, total: keptItems.length };
		}

		// Common-phrase analysis: a matched phrase that appears in many
		// checked sources is field-standard wording, not strong evidence.
		let commonDf = Math.max(this.COMMON_DF_MIN, Math.ceil(compared * this.COMMON_DF_FRAC));
		for (let r of rows) {
			for (let p of r.passages) {
				let g0 = p.wordStart, g1 = Math.max(g0, p.wordEnd - n + 1);
				let hi = 0;
				for (let g = g0; g < g1; g++) {
					if ((df.get(to.gramHashes[g]) || 0) >= commonDf) hi++;
				}
				p.common = hi / Math.max(1, g1 - g0) > this.COMMON_PASSAGE_FRAC;
			}
			for (let p of r.passages) {
				allPassages.push({ source: r.title, text: p.text, words: p.words,
					wordStart: p.wordStart, wordEnd: p.wordEnd,
					citeStatus: p.citeStatus, common: !!p.common });
			}
		}
		let commonPos = [];
		for (let p of unionMatched) {
			if ((df.get(to.gramHashes[p]) || 0) >= commonDf) commonPos.push(p);
		}
		commonPos.sort((a, b) => a - b);
		let commonPct = this.coveredCount(commonPos, n) / Math.max(1, to.lwords.length);

		// Dampen the scores themselves: phrasing shared by many sources is
		// field-standard wording, not evidence against this paper. Both the
		// headline score and each source's coverage exclude common grams.
		// Scores are covered words over total words, not gram positions over
		// gram count - position math under-counts every run by about n-1
		// words and disagrees with the highlighted text.
		for (let r of rows) {
			let kept = [];
			let commonInRow = 0;
			for (let p of (r.matchedPos || [])) {
				if ((df.get(to.gramHashes[p]) || 0) >= commonDf) commonInRow++;
				else kept.push(p);
			}
			r.commonGrams = commonInRow;
			r.paperPct = this.coveredCount(kept, n) / Math.max(1, to.lwords.length);
		}

		rows.sort((a, b) => b.paperPct - a.paperPct || (b.nearPct || 0) - (a.nearPct || 0) || b.reusePct - a.reusePct);
		allPassages.sort((a, b) => b.words - a.words);
		let topPassagesList = allPassages.slice(0, this.TOP_PASSAGES);
		this.attributePassages(topPassagesList, rows, n);

		// ---- Paraphrase detection (fully local) ----
		let paraphrases = [], paraphraseFailed = false;
		if (cfg.paraphraseEnabled && to.lwords.length) {
			if (prog) prog.setText("Paraphrase detection (local)...");
			try {
				paraphrases = this.paraphraseLocal(to, rows, cfg);
			}
			catch (e) {
				this.log("Paraphrase check failed: " + e);
				paraphraseFailed = true;
			}
		}

		if (cfg.useIndex) {
			this.stage('saving the fingerprint index');
			await this.saveIndex();
		}

		let flagAt = cfg.flagThresholdPct / 100, watchAt = cfg.watchThresholdPct / 100;
		let sFlagAt = cfg.sourceFlagPct / 100, sWatchAt = cfg.sourceWatchPct / 100;
		let nearFlagAt = (cfg.nearMatchEnabled ? cfg.nearFlagPct : 101) / 100;
		let nearWatchAt = (cfg.nearMatchEnabled ? cfg.nearWatchPct : 101) / 100;
		let isFlag = r => r.paperPct >= flagAt || r.reusePct >= sFlagAt || (r.nearPct || 0) >= nearFlagAt;
		let isWatch = r => !isFlag(r) && (r.paperPct >= watchAt || r.reusePct >= sWatchAt || (r.nearPct || 0) >= nearWatchAt);

		let nonCommonPos = [];
		for (let p of unionMatched) {
			if ((df.get(to.gramHashes[p]) || 0) < commonDf) nonCommonPos.push(p);
		}
		nonCommonPos.sort((a, b) => a - b);
		let overall = this.coveredCount(nonCommonPos, n) / Math.max(1, to.lwords.length);
		let uncitedPassages = allPassages.filter(p => p.citeStatus == 'none').length;

		// Per-section scores, only when the paper has clear headings.
		let sections = this.splitSections(to);
		let sectionScores = sections.length >= 2
			? this.sectionScores(to, sections, unionMatched, n) : [];

		// Page numbers for the displayed source passages, where the source
		// PDF allows per-page extraction (top few sources only).
		this.stage('mapping passages to source pages');
		let pageSources = 0;
		for (let r of rows) {
			if (pageSources >= this.PAGE_SOURCES_MAX) break;
			if (!r.att || !r.pairs || !r.pairs.length) continue;
			if (prog && prog.cancelled) break;
			let pages = await this.getSourcePages(r.att);
			if (!pages) continue;
			pageSources++;
			let found = 0;
			for (let pr of r.pairs) {
				if (pr.source && pr.source.text) {
					let pg = this.findPageForSnippet(pages, pr.source.text);
					if (pg) { pr.source.page = pg; found++; }
				}
			}
			if (found) this.console('source pages: ' + r.title + ' - ' + found + ' passage(s) mapped');
		}
		if (pageSources) this.console('source pages mapped for ' + pageSources + ' source(s)');

		let results = {
			rows: rows,
			paperWords: to.words,
			paperText: to.text,
			paperOffsets: to.offsets,
			compared: compared,
			noText: noText,
			noTextList: noTextList,
			indexHits: indexHits,
			indexMisses: indexMisses,
			duplicates: duplicates,
			paraphrases: paraphrases,
			paraphraseFailed: paraphraseFailed,
			originalBasis: originalBasis,
			overall: overall,
			overallPct: (overall * 100).toFixed(1),
			commonPct: (commonPct * 100).toFixed(1),
			topPassages: topPassagesList,
			passageCount: allPassages.length,
			uncitedPassages: uncitedPassages,
			differentPassages: allPassages.filter(p => p.citeStatus == 'different').length,
			ignoredTagged: ignoredTagged,
			biblioTotal: biblio.total,
			biblioResolved: biblio.resolved,
			citedOnlyNote: citedOnlyNote,
			minorOverlaps: minorOverlaps,
			flagged: rows.filter(isFlag),
			watch: rows.filter(isWatch),
			isFlag: isFlag,
			isWatch: isWatch,
			sections: sectionScores,
			prevCheck: null,
		};
		// Record this check so the next report can compare against it.
		results.prevCheck = item.id ? await this.recordHistory(item, results) : null;
		return results;
	},

	// ---- Section detection -------------------------------------------------
	// Splits the paper into sections from heading lines (Abstract,
	// Introduction, Methods, ...). Returns [] when fewer than two headings
	// are found, so callers fall back gracefully on papers without clear
	// headings.
	splitSections(to) {
		let head = /^\s*(?:\d+(?:\.\d+)*[.\)]?\s+)?(abstract|introduction|background|related work|literature review|methods?|methodology|materials and methods|experimental(?: setup)?|results(?: and discussion)?|discussion|conclusions?|summary|acknowledg?e?ments?|references|bibliography|appendix)\s*:?\s*$/i;
		let lines = to.text.split('\n');
		let heads = [];
		let pos = 0;
		for (let line of lines) {
			let t = line.trim();
			if (t.length > 1 && t.length <= 60 && head.test(t)) {
				heads.push({
					name: t.replace(/^\s*(?:\d+(?:\.\d+)*[.\)]?\s*)/, '').replace(/:$/, ''),
					charAt: pos + line.indexOf(t),
				});
			}
			pos += line.length + 1;
		}
		if (heads.length < 2) return [];
		// Map each heading's char position to the word index that starts it.
		let sections = [];
		let wi = 0;
		for (let h of heads) {
			while (wi < to.offsets.length && to.offsets[wi] < h.charAt) wi++;
			if (sections.length && sections[sections.length - 1].wordStart == wi) continue;
			sections.push({ name: h.name, wordStart: wi });
		}
		for (let i = 0; i < sections.length; i++) {
			sections[i].wordEnd = i + 1 < sections.length ? sections[i + 1].wordStart : to.lwords.length;
		}
		// Text before the first heading is front matter when substantial.
		if (sections.length && sections[0].wordStart >= 40) {
			sections.unshift({ name: 'Front matter', wordStart: 0, wordEnd: sections[0].wordStart });
		}
		return sections.filter(s => s.wordEnd - s.wordStart > 0);
	},

	// Per-section matched share: which share of each section's grams is part
	// of any matched phrase. Pure: takes the union of matched gram indices.
	sectionScores(to, sections, unionMatched, n) {
		let out = [];
		let sorted = Array.from(unionMatched).sort((a, b) => a - b);
		for (let s of sections) {
			let g0 = s.wordStart, g1 = Math.max(g0, s.wordEnd - n + 1);
			let inRange = sorted.filter(g => g >= g0 && g < g1);
			let total = Math.max(1, s.wordEnd - s.wordStart);
			let pct = Math.min(1, this.coveredCount(inRange, n) / total);
			out.push({ name: s.name, pct: pct, words: s.wordEnd - s.wordStart });
		}
		return out;
	},

	// ---- Plain-language verdict ---------------------------------------------
	buildVerdict(results) {
		let s = [];
		let overall = parseFloat(results.overallPct);
		s.push('Overall, ' + results.overallPct + '% of this paper matches the '
			+ results.compared + ' checked source' + (results.compared == 1 ? '' : 's')
			+ ' verbatim.');
		if (results.flagged.length) {
			let top = results.flagged[0];
			s.push(results.flagged.length + ' source' + (results.flagged.length == 1 ? ' is' : 's are')
				+ ' flagged as strong overlap' + (top ? ', led by "' + top.title + '" at '
				+ (top.paperPct * 100).toFixed(1) + '% of the paper' : '') + '.'
				+ (results.watch.length ? ' ' + results.watch.length + ' more are worth a look.' : ''));
		}
		else if (results.watch.length) {
			s.push('No source is flagged, but ' + results.watch.length + ' show'
				+ (results.watch.length == 1 ? 's' : '') + ' enough overlap to review.');
		}
		else {
			s.push('No source shows meaningful overlap.');
		}
		if (results.uncitedPassages > 0) {
			s.push(results.uncitedPassages + ' matched passage'
				+ (results.uncitedPassages == 1 ? ' has' : 's have') + ' no citation nearby'
				+ (overall >= 5 ? ' - these are the first things to fix.' : '.'));
		}
		if (results.differentPassages > 0) {
			s.push(results.differentPassages + ' matched passage'
				+ (results.differentPassages == 1 ? ' cites' : 's cite')
				+ ' a DIFFERENT source than the one the text matches - check the reference list');
		}
		else if (results.passageCount > 0) {
			s.push('Every matched passage is cited or has a citation nearby.');
		}
		let reworded = results.rows.filter(r => (r.nearPct || 0) * 100 >= 40 && r.paperPct < 0.02);
		if (reworded.length) {
			s.push('"' + reworded[0].title + '" looks reworded rather than copied verbatim ('
				+ (reworded[0].nearPct * 100).toFixed(0) + '% near-match); review it by hand.');
		}
		if (parseFloat(results.commonPct) >= 2) {
			s.push(results.commonPct + '% of the paper is phrasing shared by many sources'
				+ ' (field-standard wording), shown as common phrases rather than evidence.');
		}
		if (results.minorOverlaps > 0) {
			s.push(results.minorOverlaps + ' source' + (results.minorOverlaps == 1 ? ' has' : 's have')
				+ ' only isolated short overlaps (no run of ' + this.cfg().minRunWords
				+ '+ words) and ' + (results.minorOverlaps == 1 ? 'is' : 'are') + ' not counted above.');
		}
		if (results.paraphrases && results.paraphrases.length) {
			s.push(results.paraphrases.length + ' sentence' + (results.paraphrases.length == 1 ? ' looks' : 's look')
				+ ' paraphrased from a matched source.');
		}
		return s;
	},

	// ---- Check history (before/after comparison) ----------------------------
	historyDelta(prev, cur) {
		if (!prev) return null;
		return {
			overallDelta: (cur.overall - prev.overall) * 100,
			flaggedDelta: cur.flagged - prev.flagged,
			uncitedDelta: cur.uncitedPassages - prev.uncitedPassages,
			prevDate: prev.ts,
			prevOverall: prev.overall * 100,
			prevFlagged: prev.flagged,
		};
	},

	async loadHistory() {
		if (this._history) return this._history;
		this._history = { items: {} };
		try {
			let dir = Zotero.getZoteroDirectory();
			dir.append(this.HISTORY_FILE);
			let data = JSON.parse(await Zotero.File.getContentsAsync(dir.path));
			if (data && data.items) this._history = data;
		}
		catch (e) {
			// No history yet, or unreadable: start empty
		}
		return this._history;
	},

	async saveHistory() {
		if (!this._history) return;
		try {
			let dir = Zotero.getZoteroDirectory();
			dir.append(this.HISTORY_FILE);
			await Zotero.File.putContentsAsync(dir.path, JSON.stringify(this._history));
		}
		catch (e) {
			this.log('Saving history failed: ' + e);
		}
	},

	// Record this check and return the previous entry for the same paper.
	async recordHistory(item, results) {
		try {
			let history = await this.loadHistory();
			let key = 'i' + item.id;
			let list = history.items[key] || (history.items[key] = []);
			let prev = list.length ? list[list.length - 1] : null;
			list.push({
				ts: new Date().toISOString(),
				overall: results.overall,
				flagged: results.flagged.length,
				watch: results.watch.length,
				compared: results.compared,
				uncitedPassages: results.uncitedPassages,
			});
			if (list.length > this.HISTORY_MAX_PER_ITEM) {
				list.splice(0, list.length - this.HISTORY_MAX_PER_ITEM);
			}
			await this.saveHistory();
			return prev;
		}
		catch (e) {
			this.log('Recording history failed: ' + e);
			return null;
		}
	},

	// ---- Source page numbers --------------------------------------------------
	normPageText(s) {
		return String(s || '').toLowerCase().replace(/\s+/g, ' ');
	},

	// Find the 1-based page whose text contains the snippet, or null.
	findPageForSnippet(pages, snippet) {
		let needle = this.normPageText(snippet).slice(0, 80).trim();
		if (needle.length < 12) return null;
		for (let i = 0; i < pages.length; i++) {
			if (this.normPageText(pages[i]).indexOf(needle) >= 0) return i + 1;
		}
		return null;
	},

	// Per-page text of a source PDF via Zotero's PDF worker, when available
	// (Zotero 7+; older versions and non-PDF sources simply return null).
	async getSourcePages(att) {
		try {
			if (!(typeof Zotero.PDFWorker == 'object' && Zotero.PDFWorker
					&& typeof Zotero.PDFWorker.getFullText == 'function')) return null;
			let res = await Zotero.PDFWorker.getFullText(att.id, null);
			let pages = null;
			if (res && Array.isArray(res.pages)) {
				pages = res.pages.map(p => typeof p == 'string' ? p : (p && typeof p.text == 'string' ? p.text : ''));
			}
			if (!pages || !pages.length) return null;
			return pages;
		}
		catch (e) {
			this.log('Page extraction failed: ' + e);
			return null;
		}
	},

	normTitle(t) {
		return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
	},

	// "Parent > Child" path for a collection, for readable picker labels
	collPath(c) {
		let parts = [c.name], p = c;
		while (p.parentID && (p = Zotero.Collections.get(p.parentID))) parts.unshift(p.name);
		return parts.join(' > ');
	},

	// All regular items in a collection AND its subcollections, deduped
	collectionItemsDeep(col) {
		let map = new Map();
		let list = [col];
		try {
			for (let d of col.getDescendents(false, 'collection')) {
				let dc = Zotero.Collections.get(d.id);
				if (dc) list.push(dc);
			}
		}
		catch (e) {
			this.console('subcollection lookup failed, using top level only: ' + e);
		}
		for (let cc of list) {
			for (let it of cc.getChildItems()) {
				if (it.isRegularItem() && !it.deleted) map.set(it.id, it);
			}
		}
		return [...map.values()];
	},

	// ---------------------------------------------------------------
	// Paraphrase detection (fully local)
	// ---------------------------------------------------------------
	splitUnits(text, maxUnits) {
		let units = [];
		let win = this.PARA_WINDOW_WORDS, step = this.PARA_WINDOW_STEP;
		for (let s of text.split(/(?<=[.!?])\s+/)) {
			let w = s.trim().split(/\s+/).filter(Boolean);
			if (w.length < 12) continue;
			if (w.length <= win) {
				units.push(w.join(' '));
			}
			else {
				// Extracted text can lose sentence punctuation, leaving a
				// whole abstract or page as one "sentence". Cap those runs
				// into overlapping word windows.
				for (let a = 0; a + 12 <= w.length; a += step) {
					units.push(w.slice(a, a + win).join(' '));
					if (a + win >= w.length || units.length >= maxUnits) break;
				}
			}
			if (units.length >= maxUnits) break;
		}
		return units;
	},

	// Compare paper sentences that had little verbatim overlap against
	// the matched sources' sentences by content-word containment: the
	// share of the paper sentence's stemmed content words that also
	// appear in the source sentence. Fully local; no network calls.
	paraphraseLocal(to, rows, cfg) {
		let threshold = (cfg.paraContainPct || 65) / 100;
		let paperUnits = [];
		for (let u of this.splitUnits(to.text, this.PARA_MAX_UNITS)) {
			let lwords = u.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
			let stems = this.contentStems(lwords);
			if (stems.length < 6) continue;
			let grams = this.gramHashArray(lwords, cfg.ngram);
			let verbatim = grams.length ? grams.filter(g => to.unionHashes.has(g)).length / grams.length : 0;
			if (verbatim > 0.4) continue;
			paperUnits.push({ unit: u, stems: stems });
			if (paperUnits.length >= cfg.maxParaphraseUnits) break;
		}
		if (!paperUnits.length) return [];

		let srcUnits = [];
		for (let row of rows.slice(0, this.PARA_MAX_SOURCES)) {
			if (!row.srcText || !(row.paperPct > 0 || (row.nearPct || 0) * 100 >= cfg.nearWatchPct)) continue;
			for (let u of this.splitUnits(row.srcText, 20)) {
				let lwords = u.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
				let stems = this.contentStems(lwords);
				if (stems.length < 6) continue;
				srcUnits.push({ unit: u, source: row.title, stemSet: new Set(stems) });
				if (srcUnits.length >= this.PARA_MAX_SOURCE_UNITS) break;
			}
			if (srcUnits.length >= this.PARA_MAX_SOURCE_UNITS) break;
		}
		if (!srcUnits.length) return [];

		let found = [];
		for (let pu of paperUnits) {
			let best = null;
			for (let su of srcUnits) {
				let have = 0;
				for (let s of pu.stems) if (su.stemSet.has(s)) have++;
				let sim = have / pu.stems.length;
				// Both directions: the paper sentence must be covered AND the
				// source unit must be mostly about this sentence, so a large
				// source blob cannot "contain" every paper sentence at 100%.
				let srcCov = su.stemSet.size ? have / su.stemSet.size : 0;
				if (sim >= threshold && srcCov >= this.PARA_MIN_SRC_COV && (!best || sim > best.sim)) {
					best = { sim: sim, src: su };
				}
			}
			if (best) {
				found.push({ paper: pu.unit, source: best.src.unit, sourceTitle: best.src.source, sim: best.sim });
			}
		}
		found.sort((a, b) => b.sim - a.sim);
		return found.slice(0, 20);
	},

	// ---------------------------------------------------------------
	// HTML report
	// ---------------------------------------------------------------
	async deliverReport(window, item, results, meta, opts) {
		let cfg = this.cfg();
		let openIt = (opts && opts.open !== undefined) ? opts.open : cfg.autoOpenReport;
		this.console('building report html');
		let html = this.buildReportHTML(item, results, meta);
		this.console('report html: ' + html.length + ' chars');
		// Reports are kept in a persistent folder in the Zotero data
		// directory, not the temp dir, so they survive a reboot.
		let dir = Zotero.getZoteroDirectory();
		dir.append('provenance-reports');
		await Zotero.File.createDirectoryIfMissingAsync(dir.path);
		let safe = (item.getField('title') || 'report').replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 50) || 'report';
		let stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
		dir.append(safe + '_' + stamp + '.html');
		let path = dir.path;
		await Zotero.File.putContentsAsync(path, html);
		let logPath = await this.saveLog(path);
		if (logPath) this.console('log saved: ' + logPath);
		if (openIt) {
			try {
				this.console('opening report: ' + path);
				Zotero.launchFile(path);
			}
			catch (e) {
				this.console("Could not open report: " + e);
				Services.prompt.alert(window, "Provenance", "Report saved to:\n" + path);
			}
		}
		return path;
	},

	scoreClass(pct) {
		if (pct >= 25) return 'flag';
		if (pct >= 10) return 'watch';
		return 'ok';
	},

	citeChip(p) {
		if (p.citeStatus == 'cited') {
			return '<span class="cite cited">&#10003; cited: ' + this.escapeHTML(p.cite.text) + '</span>';
		}
		if (p.citeStatus == 'nearby') {
			return '<span class="cite nearby">citation nearby: ' + this.escapeHTML(p.cite.text) + '</span>';
		}
		if (p.citeStatus == 'different') {
			return '<span class="cite different">&#10007; cites a different source: ' + this.escapeHTML(p.cite.text) + '</span>';
		}
		return '<span class="cite none">&#10007; no citation nearby</span>';
	},

	// Excerpt ranges for the highlighted paper view: each matched token run
	// gets ctx words of context on both sides; ranges merge when their
	// context windows would touch.
	_hlExcerptRanges(owner, ctx) {
		let ranges = [];
		let i = 0;
		while (i < owner.length) {
			if (owner[i] < 0) { i++; continue; }
			let ws = Math.max(0, i - ctx);
			let last = i, j = i;
			while (j < owner.length) {
				if (owner[j] >= 0) last = j;
				else if (j - last > 2 * ctx) break;
				j++;
			}
			ranges.push([ws, Math.min(owner.length, last + ctx + 1)]);
			i = j;
		}
		return ranges;
	},

	// Render tokens [ws, we) from the original text (punctuation and
	// capitalization intact), wrapping matched words in source-color marks.
	_renderHlRange(text, words, offsets, owner, ws, we) {
		let out = '', pos = offsets[ws], cur = -2;
		for (let i = ws; i < we; i++) {
			let start = offsets[i];
			out += this.escapeHTML(text.slice(pos, start));
			let o = owner[i];
			if (o != cur) {
				if (cur >= 0) out += '</mark>';
				if (o >= 0) out += '<mark class="h' + (o % 8) + '"><sup>[' + (o + 1) + ']</sup> ';
				cur = o;
			}
			out += this.escapeHTML(text.slice(start, start + words[i].length));
			pos = start + words[i].length;
		}
		if (cur >= 0) out += '</mark>';
		// Trailing punctuation right after the last word (e.g. a period).
		let m = /^[^\s]{1,3}/.exec(text.slice(pos));
		if (m) out += this.escapeHTML(m[0]);
		return out.replace(/\s+/g, ' ');
	},

	// Token-join fallback when the original text is unavailable.
	_renderHlTokens(words, owner) {
		let body = '', cur = -2;
		for (let i = 0; i < words.length; i++) {
			let o = owner[i];
			if (o != cur) {
				if (cur >= 0) body += '</mark>';
				if (o >= 0) body += '<mark class="h' + (o % 8) + '"><sup>[' + (o + 1) + ']</sup> ';
				cur = o;
			}
			body += this.escapeHTML(words[i]) + ' ';
		}
		if (cur >= 0) body += '</mark>';
		return body;
	},

	// Quote helper for the compact report: passages longer than maxLen are
	// shown truncated inside a <details> whose summary is the preview;
	// expanding shows the full text, and print always shows the full text.
	_quoteWithMore(text, maxLen) {
		maxLen = maxLen || 320;
		if (!text || text.length <= maxLen) return '&ldquo;' + this.escapeHTML(text || '') + '&rdquo;';
		let cut = text.slice(0, maxLen);
		let sp = cut.lastIndexOf(' ');
		if (sp > maxLen * 0.6) cut = cut.slice(0, sp);
		// The truncated copy lives in a span inside the summary so the CSS
		// can hide it when the details opens: the full text then REPLACES
		// the short one (previously both showed, the passage twice).
		return '<details class="more"><summary><span class="qm-cut">&ldquo;' + this.escapeHTML(cut) + '&hellip;&rdquo;</span></summary>'
			+ '&ldquo;' + this.escapeHTML(text) + '&rdquo;</details>';
	},

	buildReportHTML(item, results, meta) {
		let cfg = this.cfg();
		let title = this.escapeHTML(item.getField('title') || '(untitled)');
		let creators = '';
		try { creators = item.getCreators().map(c => (c.firstName ? c.firstName + ' ' : '') + c.lastName).join(', '); } catch (e) {}
		let date = new Date().toLocaleString();
		let overallNum = Number(results.overallPct);
		let overallCls = this.scoreClass(overallNum);
		let verdict = overallNum >= 25 ? 'High similarity - review the flagged passages carefully'
			: overallNum >= 10 ? 'Moderate similarity - review the flagged sources'
			: 'Low similarity';

		let sweepLine = '';
		if (meta.mode == 'sweep') {
			let detail = meta.added + ' new, ' + meta.existing + ' existing'
				+ (cfg.fetchOaPdf ? ', ' + meta.oaFetched + ' PDFs' : '');
			sweepLine = '<div class="stat"><div class="stat-num">' + meta.totalRefs + '</div>'
				+ '<div class="stat-label">References fetched<br/>(' + detail + ')</div></div>';
		}
		let cappedLine = meta.capped
			? '<p class="note">Scope capped at the first ' + cfg.maxCompare + ' items.</p>' : '';
		// Long lists collapse behind a count line; short lists stay inline.
		let noteList = (items, render) => {
			if (items.length <= 3) return ' ' + items.map(render).join('; ') + '.';
			return ' <details class="note-list"><summary></summary>'
				+ items.map(render).join('; ') + '.</details>';
		};
		let dupLine = '';
		if (results.duplicates && results.duplicates.length) {
			dupLine = '<div class="note">Duplicates excluded from the score (' + results.duplicates.length + '):'
				+ noteList(results.duplicates, d => this.escapeHTML(this.shortNoteTitle(d.title)) + ' <i>(' + d.why + ')</i>')
				+ '</div>';
		}
		if (results.ignoredTagged && results.ignoredTagged.length) {
			dupLine += '<div class="note">Ignored by tag ' + this.escapeHTML(this.IGNORE_TAG) + ' ('
				+ results.ignoredTagged.length + '):'
				+ noteList(results.ignoredTagged, t => this.escapeHTML(this.shortNoteTitle(t))) + '</div>';
		}
		if (results.citedOnlyNote) {
			dupLine += '<p class="note">' + this.escapeHTML(results.citedOnlyNote) + '</p>';
		}
		if (results.biblioTotal) {
			dupLine += '<p class="note">Reference list: ' + results.biblioTotal + ' entries parsed, '
				+ results.biblioResolved + ' matched to sources in scope'
				+ (results.biblioResolved ? ' - numbered citations resolved against them.' : '.') + '</p>';
		}
		let noTextLine = '';
		if (results.noText && results.noTextList && results.noTextList.length) {
			noTextLine = '<div class="note warn">No text could be read for ' + results.noText
				+ ' source(s), so they could not be compared:'
				+ noteList(results.noTextList, t => this.escapeHTML(this.shortNoteTitle(t)))
				+ (results.noText > results.noTextList.length
					? ' (and ' + (results.noText - results.noTextList.length) + ' more)' : '')
				+ ' If one of these matters, select it in Zotero, right-click its PDF and choose'
				+ ' "Reindex Item", then run the check again.</div>';
		}
		let indexLine = '';
		if (cfg.useIndex && (results.indexHits || results.indexMisses)) {
			indexLine = '<p class="note">Saved index: ' + results.indexHits + ' source(s) reused from the cache, '
				+ results.indexMisses + ' newly indexed. Repeat checks skip unchanged sources.</p>';
		}
		let paraLine = '';
		if (cfg.paraphraseEnabled && results.paraphraseFailed) {
			paraLine = '<p class="note warn">Local paraphrase detection failed. Verbatim results are unaffected.</p>';
		}

		// Plain-language verdict at the top of the report.
		let verdictBox = '<div class="verdict-box">'
			+ this.buildVerdict(results).map(s => '<p>' + this.escapeHTML(s) + '</p>').join('')
			+ '</div>';

		// Before/after comparison with the previous recorded check.
		let compareBox = '';
		let delta = this.historyDelta(results.prevCheck, {
			overall: results.overall,
			flagged: results.flagged.length,
			uncitedPassages: results.uncitedPassages,
		});
		if (delta) {
			let d = delta.overallDelta;
			let dir = d <= -0.05 ? 'down' : (d >= 0.05 ? 'up' : 'unchanged');
			let cls = d <= -0.05 ? 'better' : (d >= 0.05 ? 'worse' : '');
			compareBox = '<div class="compare-box ' + cls + '">'
				+ '<span class="compare-title">Compared with the previous check ('
				+ this.escapeHTML(new Date(delta.prevDate).toLocaleString()) + '):</span> '
				+ 'overall ' + results.overallPct + '% vs ' + delta.prevOverall.toFixed(1) + '%'
				+ ' (' + (dir == 'unchanged' ? 'unchanged' : dir + ' ' + Math.abs(d).toFixed(1) + ' points') + ')'
				+ ' &middot; flagged sources ' + results.flagged.length + ' vs ' + delta.prevFlagged
				+ (delta.uncitedDelta ? ' &middot; uncited passages ' + (delta.uncitedDelta > 0 ? '+' : '') + delta.uncitedDelta : '')
				+ '</div>';
		}
		else if (results.compared) {
			compareBox = '<div class="compare-box">First recorded check of this paper'
				+ ' - the next check will show a before/after comparison here.</div>';
		}

		// Per-section scores, only when headings were detected.
		let sectionsHTML = '';
		if (results.sections && results.sections.length >= 2) {
			let srows = results.sections.map(s => {
				let pct = (s.pct * 100).toFixed(1);
				let cls = s.pct >= 0.25 ? 'flag' : (s.pct >= 0.05 ? 'watch' : 'ok');
				return '<tr class="' + cls + '"><td>' + this.escapeHTML(s.name) + '</td>'
					+ '<td class="num">' + pct + '%</td>'
					+ '<td class="num">' + s.words + '</td>'
					+ '<td class="bar-cell"><div class="bar"><div class="fill ' + cls + '" style="width:'
					+ Math.min(100, s.pct * 400) + '%"></div></div></td></tr>';
			}).join('\n');
			sectionsHTML = '<details class="rep-sec"><summary>Where the matches are ('
				+ results.sections.length + ' sections)</summary>'
				+ '<p class="note">Share of each section\'s text that matches any checked source.</p>'
				+ '<table class="sections-table"><thead><tr><th>Section</th><th class="num">Matched</th>'
				+ '<th class="num">Words</th><th class="bar-col"></th></tr></thead><tbody>' + srows + '</tbody></table></details>';
		}

		// Highlighted paper view: each of the top matching sources gets a
		// color; every word covered by a matched phrase is marked. Words
		// covered by several sources get the highest-ranked source's color.
		// 8.4: the default view is excerpts (matches with a little context)
		// rendered from the original text so punctuation and capitalization
		// read naturally; the full paper text sits behind a toggle.
		let highlightSection = '';
		if (results.paperWords && results.paperWords.length) {
			let hlRows = results.rows.filter(r => r.matchedPos && r.matchedPos.length).slice(0, 12);
			if (hlRows.length) {
				let n = cfg.ngram;
				let owner = new Int16Array(results.paperWords.length).fill(-1);
				hlRows.forEach((r, idx) => {
					for (let p of r.matchedPos) {
						for (let w = p; w < p + n && w < owner.length; w++) {
							if (owner[w] == -1) owner[w] = idx;
						}
					}
				});
				let legend = hlRows.map((r, idx) =>
					'<span class="hl-key"><mark class="h' + (idx % 8) + '">[' + (idx + 1) + ']</mark> '
					+ this.escapeHTML(this.truncate(r.title, 60)) + '</span>').join(' ');
				let body;
				if (results.paperText && results.paperOffsets && results.paperOffsets.length == results.paperWords.length) {
					let ranges = this._hlExcerptRanges(owner, this.HL_CONTEXT_WORDS);
					let excerpts = ranges.map((rg, k) =>
						'<div class="hl-excerpt" dir="auto">' + (k || rg[0] > 0 ? '<span class="hl-gap">&hellip;</span> ' : '')
						+ this._renderHlRange(results.paperText, results.paperWords, results.paperOffsets, owner, rg[0], rg[1])
						+ (rg[1] < owner.length ? ' <span class="hl-gap">&hellip;</span>' : '') + '</div>').join('\n');
					body = '<div class="paper-hl">' + excerpts + '</div>'
						+ '<details class="paper-full"><summary>Show full paper text</summary>'
						+ '<div class="paper-hl">'
						+ this._renderHlRange(results.paperText, results.paperWords, results.paperOffsets, owner, 0, results.paperWords.length)
						+ '</div></details>';
				}
				else {
					// Fallback when only tokenized words are available.
					body = '<div class="paper-hl">' + this._renderHlTokens(results.paperWords, owner) + '</div>';
				}
				highlightSection = '<details class="rep-sec"><summary>The paper, highlighted by matching source ('
					+ hlRows.length + ' sources)</summary>'
					+ '<p class="note">Each color is one of the top ' + hlRows.length
					+ ' matching sources; unmarked text matched nothing. Showing the matches with context; the full paper text is behind the toggle below.</p>'
					+ '<p class="hl-legend">' + legend + '</p>'
					+ body + '</details>';
			}
		}

		let uncitedCls = results.uncitedPassages > 0 ? 'flag' : '';

		let rowsHTML = results.rows.map((r, i) => {
			let cls = results.isFlag(r) ? 'flag' : (results.isWatch(r) ? 'watch' : 'ok');
			let badge = cls == 'flag' ? 'FLAGGED' : (cls == 'watch' ? 'REVIEW' : 'LOW');
			let pct = (r.paperPct * 100).toFixed(1);
			let reuse = (r.reusePct * 100).toFixed(0);
			let titleHTML = r.doi
				? '<a href="https://doi.org/' + encodeURIComponent(r.doi) + '">'
					+ this.escapeHTML(r.title) + '</a>'
				: this.escapeHTML(r.title);
			let shared = r.sharedAuthor ? ' &middot; <span class="shared">shared author</span>' : '';
			let uncitedMeta = r.uncited
				? ' &middot; <span class="uncited">' + r.uncited + ' passage(s) without citation</span>' : '';
			let nearMeta = (r.nearPct || 0) * 100 >= cfg.nearWatchPct
				? ' &middot; <span class="' + ((r.nearPct * 100 >= cfg.nearFlagPct) ? 'uncited' : 'shared') + '">'
					+ (r.nearPct * 100).toFixed(0) + '% near-match (reworded text, experimental)</span>' : '';

			let passages = r.passages.map(p =>
				'<blockquote dir="auto">' + this._quoteWithMore(p.text)
				+ '<span class="wc">' + p.words + ' words</span>' + this.citeChip(p)
				+ (p.common ? '<span class="cite nearby">common phrase</span>' : '') + '</blockquote>').join('');
			if (passages) {
				passages = '<details class="pass-list"><summary>Matched passages ('
					+ r.passages.length + ')</summary>' + passages + '</details>';
			}

			let sbs = '';
			if (r.pairs && r.pairs.length) {
				let pairHTML = r.pairs.map(pr =>
					'<div class="pair">'
					+ '<div class="side"><div class="side-label">Your paper</div><div class="side-text" dir="auto">'
					+ (pr.paper ? '&ldquo;' + this.escapeHTML(pr.paper.text) + '&rdquo; <span class="wc">' + pr.paper.words + ' words</span>' : '<i>-</i>')
					+ '</div></div>'
					+ '<div class="side"><div class="side-label">Source</div><div class="side-text" dir="auto">'
					+ (pr.source ? '&ldquo;' + this.escapeHTML(pr.source.text) + '&rdquo; <span class="wc">' + pr.source.words + ' words</span>'
						+ (pr.source.page ? ' <span class="wc page-chip">source page ' + pr.source.page + '</span>' : '') : '<i>-</i>')
					+ '</div></div>'
					+ '</div>').join('');
				sbs = '<details class="sbs"><summary>Compare side by side (' + r.pairs.length + ')</summary>'
					+ pairHTML + '</details>';
			}

			return '<tr class="' + cls + '" data-pct="' + pct + '" data-near="' + ((r.nearPct || 0) * 100).toFixed(0)
				+ '" data-reuse="' + reuse + '" data-year="' + this.escapeHTML(r.year || '0')
				+ '" data-title="' + this.escapeHTML(r.title.toLowerCase()) + '">'
				+ '<td class="rank">' + (i + 1) + '</td>'
				+ '<td><div class="ref-title">' + titleHTML + '</div>'
				+ '<div class="ref-meta">' + this.escapeHTML(r.year || '') + ' &middot; ' + r.basis
				+ ' &middot; ' + r.matchedCount + ' phrase matches &middot; reuses ' + reuse + '% of this source'
				+ nearMeta + shared + uncitedMeta + '</div>'
				+ passages + sbs + '</td>'
				+ '<td class="score"><span class="badge ' + cls + '">' + badge + '</span>'
				+ '<div class="bar"><div class="fill ' + cls + '" style="width:' + Math.min(100, pct * 4) + '%"></div></div>'
				+ '<div class="pct">' + pct + '%</div>'
				+ '<div class="pct-label">of paper</div></td>'
				+ '</tr>';
		}).join('\n');

		if (!rowsHTML) {
			rowsHTML = '<tr><td colspan="3" class="empty">No verbatim or reworded overlap found. This paper looks clean against the checked scope.</td></tr>';
		}

		let topPassagesHTML = results.topPassages.map(p =>
			'<div class="passage"><div class="passage-src">' + this.escapeHTML(p.source)
			+ ' <span class="wc">' + p.words + ' words</span>'
			+ (p.citeStatus == 'none' ? '<span class="cite none">&#10007; no citation</span>' : '')
			+ (p.citeStatus == 'different' ? '<span class="cite different">&#10007; cites a different source</span>' : '')
			+ (p.common ? '<span class="cite nearby">common phrase</span>' : '')
			+ (p.provenance ? '<span class="cite cited">' + this.escapeHTML(p.provenance) + '</span>' : '')
			+ '</div>'
			+ '<div class="passage-text" dir="auto">' + this._quoteWithMore(p.text) + '</div></div>'
		).join('\n');
		let topSection = topPassagesHTML
			? '<details class="rep-sec"><summary>Longest matched passages ('
				+ results.topPassages.length + ')</summary>' + topPassagesHTML + '</details>'
			: '';

		let paraSection = '';
		if (results.paraphrases && results.paraphrases.length) {
			paraSection = '<details class="rep-sec"><summary>Possible paraphrases ('
				+ results.paraphrases.length + ', experimental)</summary>'
				+ '<p class="note">No verbatim 8-word match, but local content-word analysis found these '
				+ 'paper sentences share most of their content words with source text. Review each pair by hand.</p>'
				+ results.paraphrases.map(p =>
					'<div class="passage"><div class="passage-src">'
					+ this.escapeHTML(p.sourceTitle)
					+ ' <span class="wc">' + Math.round(p.sim * 100) + '% similar</span></div>'
					+ '<div class="pair">'
					+ '<div class="side"><div class="side-label">Your paper</div><div class="side-text">'
					+ this._quoteWithMore(p.paper) + '</div></div>'
					+ '<div class="side"><div class="side-label">Source</div><div class="side-text">'
					+ this._quoteWithMore(p.source) + '</div></div>'
					+ '</div></div>').join('\n')
				+ '</details>';
		}

		let csvData = results.rows.map((r, i) => ({
			rank: i + 1,
			title: r.title,
			year: r.year,
			paperMatchPct: (r.paperPct * 100).toFixed(1),
			nearMatchPct: ((r.nearPct || 0) * 100).toFixed(0),
			sourceReusedPct: (r.reusePct * 100).toFixed(0),
			matchedPhrases: r.matchedCount,
			longestPassageWords: r.passages.length ? r.passages[0].words : 0,
			uncitedPassages: r.uncited,
			sharedAuthor: r.sharedAuthor ? 'yes' : '',
			checkedAgainst: r.basis,
			doi: r.doi || '',
		}));
		let csvJSON = JSON.stringify(csvData).replace(/</g, '\\u003c');

		let excl = [];
		if (cfg.excludeQuoted) excl.push('quoted text excluded');
		if (cfg.excludeBibliography) excl.push('bibliography excluded');

		// 8.3 compact report: heavy sections are collapsed <details> with
		// counts in their summaries (built above); score, verdict, cards and
		// the ranked sources table stay visible. beforeprint opens every
		// details so Save as PDF still prints everything.

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<link rel="icon" type="image/png" href="data:image/png;base64,${this.REPORT_ICON_B64}"/>
<title>Provenance Report - ${title}</title>
<style>
  :root { --ink:#1c1c28; --muted:#6b7280; --accent:#4f46e5; --flag:#dc2626; --watch:#d97706; --ok:#059669; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:#f3f4f8; }
  .hero { background:linear-gradient(135deg,#312e81,#4f46e5 55%,#7c3aed); color:#fff; padding:26px 24px 24px; }
  .hero-inner { max-width:960px; margin:0 auto; display:flex; gap:32px; align-items:center; flex-wrap:wrap; }
  .hero-left { flex:1 1 400px; }
  .hero h1 { margin:0 0 4px; font-size:21px; letter-spacing:.2px; }
  .hero .paper { font-size:15px; font-weight:600; opacity:.95; }
  .hero .byline { opacity:.8; font-size:13px; margin-top:4px; }
  .hero .meta { opacity:.75; font-size:12px; margin-top:8px; }
  .score-card { background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.25); border-radius:14px; padding:14px 22px; text-align:center; min-width:180px; }
  .score-num { font-size:34px; font-weight:800; line-height:1; }
  .score-num.ok { color:#6ee7b7; } .score-num.watch { color:#fcd34d; } .score-num.flag { color:#fca5a5; }
  .score-label { font-size:12px; opacity:.85; margin-top:6px; letter-spacing:.4px; text-transform:uppercase; }
  .verdict { font-size:13px; margin-top:8px; opacity:.9; }
  .cards { max-width:960px; margin:-16px auto 0; padding:0 24px; display:flex; flex-wrap:wrap; gap:10px; }
  .stat { background:#fff; border-radius:10px; padding:10px 14px; flex:1 1 130px; box-shadow:0 4px 12px rgba(28,28,40,.07); }
  .stat-num { font-size:21px; font-weight:700; }
  .stat-num.flag { color:var(--flag); } .stat-num.watch { color:var(--watch); }
  .stat-label { font-size:12px; color:var(--muted); margin-top:2px; line-height:1.4; }
  main { max-width:960px; margin:18px auto 60px; padding:0 24px; }
  h2 { font-size:18px; margin:26px 0 12px; }
  .toolbar { display:flex; gap:10px; align-items:center; margin-bottom:6px; }
  .toolbar input { flex:1; padding:9px 14px; border:1px solid #e5e7eb; border-radius:999px; font-size:13px; outline:none; }
  .toolbar input:focus { border-color:var(--accent); }
  .toolbar button { padding:9px 16px; border:0; border-radius:999px; background:var(--accent); color:#fff; font-size:13px; font-weight:600; cursor:pointer; }
  .toolbar button:hover { opacity:.9; }
  .toolbar select { padding:9px 12px; border:1px solid #e5e7eb; border-radius:999px; font-size:13px; background:#fff; cursor:pointer; }
  @media print {
    body { background:#fff; }
    .toolbar, .hero .score, button, select, input { display:none !important; }
    .hero { background:#312e81 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    td, .stat, .passage, blockquote { box-shadow:none !important; border:1px solid #e5e7eb; }
    main { max-width:100%; }
    h2 { page-break-after:avoid; }
    tr, .passage { page-break-inside:avoid; }
  }
  table { width:100%; border-collapse:separate; border-spacing:0 10px; }
  td { background:#fff; padding:14px 16px; vertical-align:top; }
  tr td:first-child { border-radius:10px 0 0 10px; }
  tr td:last-child { border-radius:0 10px 10px 0; }
  .rank { color:var(--muted); font-weight:600; width:40px; }
  .ref-title { font-weight:600; font-size:14px; }
  .ref-title a { color:inherit; text-decoration:none; border-bottom:1px dotted #a5b4fc; }
  .ref-title a:hover { color:var(--accent); }
  .ref-meta { color:var(--muted); font-size:12px; margin:3px 0 8px; }
  .shared { color:#7c3aed; font-weight:600; }
  .ext { color:#0369a1; font-weight:600; }
  .uncited { color:var(--flag); font-weight:600; }
  blockquote { margin:6px 0 0; padding:6px 12px; border-left:3px solid #c7d2fe; background:#eef2ff; border-radius:0 6px 6px 0; font-size:12px; color:#3730a3; font-style:italic; }
  .wc { font-style:normal; font-size:10px; font-weight:700; color:var(--accent); margin-left:8px; white-space:nowrap; }
  .cite { font-style:normal; font-size:10px; font-weight:700; margin-left:8px; padding:2px 7px; border-radius:999px; white-space:nowrap; }
  .cite.cited { background:#d1fae5; color:#065f46; }
  .cite.nearby { background:#e5e7eb; color:#4b5563; }
  .cite.none { background:#fee2e2; color:#991b1b; }
  .cite.different { background:#ffedd5; color:#9a3412; }
  details.sbs { margin-top:8px; }
  details.sbs summary { cursor:pointer; font-size:12px; font-weight:700; color:var(--accent); }
  .pair { display:flex; gap:10px; margin-top:8px; }
  .side { flex:1; background:#f8faff; border:1px solid #e0e7ff; border-radius:8px; padding:8px 10px; }
  .side-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); margin-bottom:4px; }
  .side-text { font-size:12px; color:#3730a3; font-style:italic; }
  .score { width:170px; }
  .badge { display:inline-block; font-size:10px; font-weight:700; letter-spacing:.6px; padding:3px 8px; border-radius:999px; color:#fff; }
  .badge.flag { background:var(--flag); } .badge.watch { background:var(--watch); } .badge.ok { background:var(--ok); }
  .bar { margin-top:8px; height:8px; background:#e5e7eb; border-radius:999px; overflow:hidden; }
  .fill { height:100%; border-radius:999px; }
  .fill.flag { background:var(--flag); } .fill.watch { background:var(--watch); } .fill.ok { background:var(--ok); }
  .pct { font-size:13px; font-weight:700; margin-top:5px; }
  .pct-label { font-size:10px; color:var(--muted); }
  .empty { text-align:center; color:var(--ok); font-weight:600; padding:30px; }
  .passage { background:#fff; border-radius:10px; padding:14px 16px; margin-bottom:10px; }
  .paper-hl { background:#fff; border-radius:10px; padding:16px 18px; font-size:13px; line-height:1.9; max-height:70vh; overflow-y:auto; }
  .paper-hl mark { padding:1px 2px; border-radius:3px; color:#1c1c28; }
  .paper-hl sup { font-size:9px; font-weight:700; }
  .hl-legend { font-size:12px; line-height:2; }
  .hl-legend mark { padding:0 4px; border-radius:3px; font-weight:700; }
  mark.h0 { background:#fecaca; } mark.h1 { background:#fde68a; } mark.h2 { background:#bbf7d0; } mark.h3 { background:#bfdbfe; }
  mark.h4 { background:#ddd6fe; } mark.h5 { background:#fbcfe8; } mark.h6 { background:#a5f3fc; } mark.h7 { background:#fed7aa; }
  .passage-src { font-size:12px; font-weight:700; color:var(--ink); margin-bottom:6px; }
  .passage-text { font-size:13px; color:#3730a3; font-style:italic; background:#eef2ff; border-left:3px solid #c7d2fe; padding:8px 12px; border-radius:0 6px 6px 0; }
  .note { color:var(--muted); font-size:12px; margin:0 0 7px; line-height:1.5; }
  details.note-list { display:inline; }
  details.note-list > summary { display:inline; cursor:pointer; list-style:none; color:var(--accent); font-weight:700; font-size:11px; }
  details.note-list > summary::-webkit-details-marker { display:none; }
  details.note-list > summary::after { content:'show the list'; }
  details.note-list[open] > summary::after { content:'hide the list'; }
  details.note-list[open] { display:block; margin:2px 0 2px 12px; }
  .verdict-box { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:14px 18px; margin:0 0 14px; font-size:14px; line-height:1.55; }
  .verdict-box p { margin:0 0 6px; } .verdict-box p:last-child { margin:0; }
  .compare-box { border-left:4px solid #94a3b8; background:#f8fafc; padding:8px 14px; border-radius:0 8px 8px 0; font-size:13px; margin:0 0 14px; color:var(--muted); }
  .compare-box .compare-title { font-weight:700; color:var(--ink); }
  .compare-box.better { border-color:#16a34a; background:#f0fdf4; }
  .compare-box.worse { border-color:var(--flag); background:#fef2f2; }
  .sections-table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #e5e7eb; border-radius:10px; overflow:hidden; font-size:13px; margin-bottom:20px; }
  details.rep-sec { margin:18px 0; }
  details.rep-sec > summary { cursor:pointer; font-size:18px; font-weight:700; margin:8px 0 12px; }
  details.pass-list { margin-top:6px; }
  details.pass-list > summary { cursor:pointer; font-size:12px; font-weight:700; color:var(--accent); }
  details.more { display:inline; }
  details.more > summary { display:inline; cursor:pointer; list-style:none; }
  details.more > summary::-webkit-details-marker { display:none; }
  details.more > summary::after { content:' show more'; color:var(--accent); font-style:normal; font-weight:700; font-size:10px; white-space:nowrap; }
  details.more[open] > summary::after { content:' show less'; }
  details.more[open] > summary .qm-cut { display:none; }
  @media print {
    details.more > summary::after { content:''; }
    details.more[open] > summary { display:none; }
    .paper-hl { max-height:none; overflow:visible; }
  }
  .sections-table th, .sections-table td { text-align:left; padding:8px 12px; border-bottom:1px solid #e5e7eb; }
  .sections-table .num, .sections-table th.num, .sections-table td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .sections-table th.bar-col, .sections-table td.bar-cell { width:160px; }
  .sections-table td.bar-cell .bar { width:100%; min-width:120px; }
  .hl-excerpt { margin-bottom:10px; }
  .hl-gap { color:var(--muted); font-weight:700; }
  details.paper-full { margin-top:10px; }
  details.paper-full > summary { cursor:pointer; font-size:12px; font-weight:700; color:var(--accent); }
  .page-chip { color:#4f46e5; font-weight:700; }
  .note.warn { color:var(--flag); }
  footer { max-width:960px; margin:0 auto; padding:0 24px 50px; color:var(--muted); font-size:12px; line-height:1.6; }
</style>
</head>
<body>
<div class="hero"><div class="hero-inner">
  <div class="hero-left">
    <h1>Provenance Report</h1>
    <div class="paper">${title}</div>
    <div class="byline">${this.escapeHTML(creators)}</div>
    <div class="meta">Scope: ${this.escapeHTML(meta.scopeLabel)} &middot; Checked as: ${this.escapeHTML(results.originalBasis)} &middot; ${excl.join(', ') || 'nothing excluded'} &middot; ${this.escapeHTML(date)}</div>
  </div>
  <div class="score-card">
    <div class="score-num ${overallCls}">${results.overallPct}%</div>
    <div class="score-label">Overall similarity</div>
    <div class="verdict">${verdict}</div>
  </div>
</div></div>

<div class="cards">
  ${sweepLine}
  <div class="stat"><div class="stat-num">${results.compared}</div><div class="stat-label">Sources compared<br/>(${results.noText} had no text to check)</div></div>
  <div class="stat"><div class="stat-num flag">${results.flagged.length}</div><div class="stat-label">Flagged sources</div></div>
  <div class="stat"><div class="stat-num watch">${results.watch.length}</div><div class="stat-label">Worth a look</div></div>
  <div class="stat"><div class="stat-num ${uncitedCls}">${results.uncitedPassages}</div><div class="stat-label">Passages without citation</div></div>
</div>

<main>
  ${verdictBox}
  ${compareBox}
  ${cappedLine}
  ${noTextLine}
  ${dupLine}
  ${indexLine}
  ${paraLine}
  ${topSection}
  ${paraSection}
  ${highlightSection}
  <h2>Sources, ranked by how much of the paper they match</h2>
  <div class="toolbar">
    <input id="q" type="search" placeholder="Filter by title, year or passage..."/>
    <select id="sort">
      <option value="pct">Sort: paper match %</option>
      <option value="near">Sort: near-match %</option>
      <option value="reuse">Sort: source reused %</option>
      <option value="year">Sort: year (newest)</option>
      <option value="title">Sort: title A-Z</option>
    </select>
    <button onclick="downloadCSV()">Download CSV</button>
    <button onclick="window.print()">Save as PDF</button>
  </div>
  <table id="results"><tbody>${rowsHTML}</tbody></table>
  ${sectionsHTML}
</main>

<footer>
<details class="rep-sec howto"><summary>How to read this report</summary>
  Overall similarity is the share of the paper's word ${cfg.ngram}-grams
  (${cfg.ngram}-word phrases) found verbatim in any checked source. For each source, the big percentage is how much
  of the paper it covers; "reuses X% of this source" is the reverse direction, which catches short but
  heavily-mined sources. A source is flagged when paper coverage reaches ${cfg.flagThresholdPct}%, source
  reuse reaches ${cfg.sourceFlagPct}%, or near-match reaches ${cfg.nearFlagPct}%. "Near-match" is the share of the
  paper's stemmed content words (stopwords and numbers removed) found in the source; it catches lightly
  reworded copying and never counts toward the overall score. Each passage is checked for a nearby citation:
  author-year citations are matched to the source by author or year; numbered citations like [12] are marked
  "citation nearby" because they cannot be tied to a specific source automatically. Sources marked "abstract
  only" were compared at the abstract level; their scores are lower bounds.
  Passages marked "common phrase" are wording that appears in many of the checked sources
  (field-standard phrasing or boilerplate) and are de-emphasized as evidence. Common phrases,
  methods boilerplate and proper quotes can raise scores - a flag means
  "review these passages", not "this is plagiarism". Duplicate copies of the paper or of a
  source (same DOI or title) are excluded from the score and listed above. Speed: a saved
  fingerprint index skips re-reading unchanged sources on repeat checks. Everything is computed
  locally; no text leaves this computer.
  Near-match and paraphrase detection are experimental: they catch lightly reworded wording that
  keeps the same content words, but synonym-level paraphrasing is a known limit, so treat their hits as
  leads for manual review, not proof. Thresholds, exclusions, the index, near-match and paraphrase
  detection are adjustable under
  Edit -&gt; Settings -&gt; Provenance.
</details>
  Generated by Provenance &middot; <a href="https://orcid.org/0009-0002-7902-690X" style="color:inherit">Ahmed Abdelmageed</a> &middot; <a href="https://github.com/asmpro7/provenance" style="color:inherit">github.com/asmpro7/provenance</a>.
</footer>

<script>
const DATA = ${csvJSON};
function downloadCSV() {
  const head = ['Rank','Title','Year','Paper match %','Near-match %','Source reused %','Matched phrases','Longest passage (words)','Uncited passages','Shared author','Checked against','DOI'];
  const esc = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const lines = [head.map(esc).join(',')].concat(
    DATA.map(r => [r.rank, r.title, r.year, r.paperMatchPct, r.nearMatchPct, r.sourceReusedPct, r.matchedPhrases, r.longestPassageWords, r.uncitedPassages, r.sharedAuthor, r.checkedAgainst, r.doi].map(esc).join(','))
  );
  const blob = new Blob(['\uFEFF' + lines.join('\\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'provenance-report.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
document.getElementById('q').addEventListener('input', function () {
  const s = this.value.toLowerCase();
  document.querySelectorAll('#results tbody tr').forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(s) ? '' : 'none';
  });
});
document.getElementById('sort').addEventListener('change', function () {
  const key = this.value;
  const tbody = document.querySelector('#results tbody');
  const rows = [...tbody.querySelectorAll('tr')];
  const val = tr => key === 'title' ? tr.dataset.title : parseFloat(tr.dataset[key] || '0');
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (key === 'title') return va < vb ? -1 : va > vb ? 1 : 0;
    return vb - va;
  });
  rows.forEach((tr, i) => { const r = tr.querySelector('.rank'); if (r) r.textContent = i + 1; tbody.appendChild(tr); });
});
window.addEventListener('beforeprint', () => document.querySelectorAll('details').forEach(d => { d.dataset.was = d.open ? '1' : ''; d.open = true; }));
window.addEventListener('afterprint', () => document.querySelectorAll('details').forEach(d => { if (!d.dataset.was) d.open = false; }));
</script>
</body>
</html>`;
	},

	// ---------------------------------------------------------------
	// Compact summary note on the paper
	// ---------------------------------------------------------------
	async attachSummaryNote(item, results, meta, reportPath) {
		// A standalone PDF is an attachment, and Zotero refuses a note whose
		// parent is not a regular item - skip the note rather than ending
		// the whole check in an error after the report was written.
		if (!item.isRegularItem || !item.isRegularItem()) return;
		let top = results.rows.slice(0, 10).map(r =>
			'<li>' + (r.paperPct * 100).toFixed(1) + '% of paper - ' + this.escapeHTML(r.title)
			+ (r.uncited ? ' <b>(' + r.uncited + ' uncited passage(s))</b>' : '')
			+ ' <i>(' + r.basis + ')</i></li>').join('');
		let html = '<h3>Provenance - plagiarism check summary</h3>'
			+ '<p><b>Overall similarity:</b> ' + results.overallPct + '%<br/>'
			+ '<b>Scope:</b> ' + this.escapeHTML(meta.scopeLabel) + '<br/>'
			+ '<b>Compared:</b> ' + results.compared + ' sources, <b>flagged:</b> ' + results.flagged.length
			+ ', <b>uncited passages:</b> ' + results.uncitedPassages + '<br/>'
			+ '<b>Full report:</b> ' + this.escapeHTML(reportPath) + '</p>'
			+ (top ? '<ol>' + top + '</ol>' : '<p>No overlap found.</p>');

		let note = new Zotero.Item('note');
		note.libraryID = item.libraryID;
		note.parentID = item.id;
		note.setNote(html);
		await note.saveTx();
	},

	escapeHTML(s) {
		return String(s).replace(/[&<>"']/g, c => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
		}[c]));
	},
};
