// Module hooks for the wiring test: a stand-in for the Pi package the extension imports at run time, so it loads
// without Pi installed. getAgentDir reads PI_CODING_AGENT_DIR, as Pi's own does.
const stubs = {
	"@earendil-works/pi-coding-agent": "export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n",
};

export async function resolve(specifier, context, next) {
	if (specifier in stubs) {
		return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
	}
	return next(specifier, context);
}
