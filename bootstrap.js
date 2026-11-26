var Provenance;

function log(msg) {
	Zotero.debug("Provenance: " + msg);
}

function install() {
	log("Installed");
}

async function startup({ id, version, rootURI }) {
	log("Starting");

	Zotero.PreferencePanes.register({
		pluginID: 'provenance@example.com',
		src: rootURI + 'preferences.xhtml',
		scripts: [rootURI + 'preferences.js']
	});

	Services.scriptloader.loadSubScript(rootURI + 'main.js');
	Provenance.init({ id, version, rootURI });
	Provenance.addToAllWindows();
	await Provenance.main();
}

function onMainWindowLoad({ window }) {
	Provenance.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	Provenance.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down");
	Provenance.removeFromAllWindows();
	Provenance = undefined;
}

function uninstall() {
	log("Uninstalled");
}
