interface SceneAnalysisServiceLike extends Instance {
	GetInstanceCompositionAsync(this: SceneAnalysisServiceLike): unknown;
	GetScriptMemoryAsync(this: SceneAnalysisServiceLike): unknown;
	GetUnparentedInstancesAsync(this: SceneAnalysisServiceLike): unknown;
	GetTriangleCompositionAsync(this: SceneAnalysisServiceLike): unknown;
	GetAnimationMemoryAsync(this: SceneAnalysisServiceLike): unknown;
	GetAudioMemoryAsync(this: SceneAnalysisServiceLike): unknown;
}

interface SceneAnalysisNode {
	Name?: string;
	Size?: number;
	Sizes?: Record<string, number>;
	Children?: SceneAnalysisNode[];
	AssetId?: string;
}

interface ModeConfig {
	method: string;
	query: (service: SceneAnalysisServiceLike) => unknown;
	sortByTriangles?: boolean;
}

const MODE_CONFIGS: Record<string, ModeConfig> = {
	instance_composition: {
		method: "GetInstanceCompositionAsync",
		query: (service) => service.GetInstanceCompositionAsync(),
	},
	script_memory: {
		method: "GetScriptMemoryAsync",
		query: (service) => service.GetScriptMemoryAsync(),
	},
	unparented_instances: {
		method: "GetUnparentedInstancesAsync",
		query: (service) => service.GetUnparentedInstancesAsync(),
	},
	triangle_composition: {
		method: "GetTriangleCompositionAsync",
		query: (service) => service.GetTriangleCompositionAsync(),
		sortByTriangles: true,
	},
	animation_memory: {
		method: "GetAnimationMemoryAsync",
		query: (service) => service.GetAnimationMemoryAsync(),
	},
	audio_memory: {
		method: "GetAudioMemoryAsync",
		query: (service) => service.GetAudioMemoryAsync(),
	},
};

const ALL_MODES = [
	"instance_composition",
	"script_memory",
	"unparented_instances",
	"triangle_composition",
	"animation_memory",
	"audio_memory",
];

function betaDisabledError(): Record<string, unknown> {
	return {
		error: "scene_analysis_not_enabled",
		message: "SceneAnalysisService is not enabled. Enable Scene Analysis in Studio Beta Features and restart Studio.",
		betaFeatureRequired: true,
	};
}

function isBetaDisabledError(value: unknown): boolean {
	return typeIs(value, "string") && string.find(value, "SceneAnalysisService is not enabled", 1, true)[0] !== undefined;
}

function getSceneAnalysisService(): SceneAnalysisServiceLike | Record<string, unknown> {
	const provider = game as unknown as { GetService(serviceName: string): Instance };
	const [ok, service] = pcall(() => provider.GetService("SceneAnalysisService") as SceneAnalysisServiceLike);
	if (!ok || !service) {
		return {
			error: "scene_analysis_unavailable",
			message: `SceneAnalysisService is unavailable: ${tostring(service)}`,
		};
	}
	return service;
}

function normalizeMode(mode: unknown): string | Record<string, unknown> {
	if (mode === undefined || mode === "all") return "all";
	if (!typeIs(mode, "string") || MODE_CONFIGS[mode] === undefined) {
		return {
			error: "invalid_mode",
			message: `mode must be one of: all, ${ALL_MODES.join(", ")}`,
		};
	}
	return mode;
}

function normalizeTopN(topN: unknown): number {
	if (!typeIs(topN, "number")) return 10;
	return math.clamp(math.floor(topN), 1, 100);
}

function countLeaves(node: SceneAnalysisNode): number {
	const children = node.Children;
	if (children && children.size() > 0) {
		let total = 0;
		for (const child of children) total += countLeaves(child);
		return total;
	}
	return 1;
}

function flattenLeaves(node: SceneAnalysisNode, out: SceneAnalysisNode[]): void {
	const children = node.Children;
	if (children && children.size() > 0) {
		for (const child of children) flattenLeaves(child, out);
		return;
	}
	out.push(node);
}

function compactEntry(node: SceneAnalysisNode): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		name: node.Name,
	};
	if (node.Size !== undefined) entry.size = node.Size;
	if (node.Sizes !== undefined) entry.sizes = node.Sizes;
	if (node.AssetId !== undefined) entry.asset_id = node.AssetId;
	return entry;
}

function compactRoot(node: SceneAnalysisNode, leafCount: number): Record<string, unknown> {
	const children = node.Children;
	const root: Record<string, unknown> = {
		name: node.Name,
		child_count: children ? children.size() : 0,
		leaf_count: leafCount,
	};
	if (node.Size !== undefined) root.size = node.Size;
	if (node.Sizes !== undefined) root.sizes = node.Sizes;
	return root;
}

function metric(node: SceneAnalysisNode, sortByTriangles: boolean): number {
	if (sortByTriangles) {
		const sizes = node.Sizes;
		const triangles = sizes ? sizes.Triangles : undefined;
		return triangles ?? 0;
	}
	return node.Size ?? 0;
}

function summarizeMode(
	mode: string,
	config: ModeConfig,
	service: SceneAnalysisServiceLike,
	topN: number,
	raw: boolean,
): Record<string, unknown> {
	const started = os.clock();
	const [ok, result] = pcall(() => config.query(service) as SceneAnalysisNode);
	const elapsedMs = math.floor((os.clock() - started) * 1000);

	if (!ok) {
		if (isBetaDisabledError(result)) return betaDisabledError();
		return {
			error: "scene_analysis_query_failed",
			mode,
			method: config.method,
			message: tostring(result),
		};
	}

	const tree = result as SceneAnalysisNode;
	const leaves: SceneAnalysisNode[] = [];
	flattenLeaves(tree, leaves);
	leaves.sort((a, b) => metric(a, config.sortByTriangles === true) > metric(b, config.sortByTriangles === true));

	const top: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(topN, leaves.size()); i++) {
		top.push(compactEntry(leaves[i]));
	}

	const body: Record<string, unknown> = {
		mode,
		method: config.method,
		elapsed_ms: elapsedMs,
		root: compactRoot(tree, leaves.size()),
		top,
	};
	if (raw) body.tree = tree;
	return body;
}

function getSceneAnalysis(requestData: Record<string, unknown>): unknown {
	const mode = normalizeMode(requestData.mode);
	if (!typeIs(mode, "string")) return mode;

	const serviceOrError = getSceneAnalysisService();
	if (!serviceOrError.IsA) return serviceOrError;
	const service = serviceOrError as SceneAnalysisServiceLike;
	const topN = normalizeTopN(requestData.topN);
	const raw = requestData.raw === true;

	if (mode !== "all") {
		return summarizeMode(mode, MODE_CONFIGS[mode], service, topN, raw);
	}

	const body: Record<string, unknown> = {};
	for (const m of ALL_MODES) {
		const result = summarizeMode(m, MODE_CONFIGS[m], service, topN, raw);
		if (result.error === "scene_analysis_not_enabled") return result;
		body[m] = result;
	}
	return body;
}

export = { getSceneAnalysis };
