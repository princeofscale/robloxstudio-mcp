import Utils from "../Utils";
import Recording from "../Recording";

const AssetService = game.GetService("AssetService");
const ChangeHistoryService = game.GetService("ChangeHistoryService");
const Selection = game.GetService("Selection");

const { getInstancePath, getInstanceByPath } = Utils;
const { beginRecording, finishRecording } = Recording;

function insertAsset(requestData: Record<string, unknown>) {
	const assetId = requestData.assetId as number;
	const parentPath = (requestData.parentPath as string) ?? "game.Workspace";
	const position = requestData.position as { x: number; y: number; z: number } | undefined;

	if (!assetId) {
		return { error: "assetId is required" };
	}

	const parentInstance = getInstanceByPath(parentPath);
	if (!parentInstance) {
		return { error: `Parent instance not found: ${parentPath}` };
	}

	const recordingId = beginRecording(`Insert asset ${assetId}`);

	let wrapperModel: Instance | undefined;
	const [insertSuccess, insertResult] = pcall(() => {
		const loadedWrapper = (AssetService as unknown as { LoadAssetAsync(id: number): Instance }).LoadAssetAsync(assetId);
		wrapperModel = loadedWrapper;

		const insertedInstances: Instance[] = [];
		const children = loadedWrapper.GetChildren();

		for (const child of children) {
			child.Parent = parentInstance;
			insertedInstances.push(child);
		}

		if (position) {
			const pos = new Vector3(position.x ?? 0, position.y ?? 0, position.z ?? 0);
			for (const inst of insertedInstances) {
				if (inst.IsA("BasePart")) {
					inst.Position = pos;
				} else if (inst.IsA("Model")) {
					if (inst.PrimaryPart) {
						inst.PivotTo(new CFrame(pos));
					} else {
						const firstPart = inst.FindFirstChildWhichIsA("BasePart", true);
						if (firstPart) {
							inst.PivotTo(new CFrame(pos));
						}
					}
				}
			}
		}

		pcall(() => {
			Selection.Set(insertedInstances);
		});

		const resultInstances = insertedInstances.map((inst) => ({
			name: inst.Name,
			className: inst.ClassName,
			path: getInstancePath(inst),
		}));

		return {
			success: true,
			assetId,
			parentPath,
			insertedCount: insertedInstances.size(),
			instances: resultInstances,
		};
	});

	if (wrapperModel) {
		pcall(() => {
			wrapperModel!.Destroy();
		});
	}

	finishRecording(recordingId, insertSuccess);

	if (!insertSuccess) {
		return { error: `Failed to insert asset ${assetId}: ${tostring(insertResult)}` };
	}

	return insertResult;
}

function previewAsset(requestData: Record<string, unknown>) {
	const assetId = requestData.assetId as number;
	const includeProperties = (requestData.includeProperties as boolean) ?? true;
	const maxDepth = (requestData.maxDepth as number) ?? 10;

	if (!assetId) {
		return { error: "assetId is required" };
	}

	const [loadSuccess, wrapperModel] = pcall(() => {
		return (AssetService as unknown as { LoadAssetAsync(id: number): Instance }).LoadAssetAsync(assetId);
	});

	if (!loadSuccess || !wrapperModel) {
		return { error: `Failed to load asset ${assetId}: ${tostring(wrapperModel)}` };
	}

	// Stats tracking
	let totalInstances = 0;
	const classCounts: Record<string, number> = {};
	let hasScripts = false;
	let hasAnimations = false;
	let hasSounds = false;
	let hasParticles = false;

	function buildHierarchy(instance: Instance, depth: number): Record<string, unknown> {
		totalInstances++;

		const className = instance.ClassName;
		classCounts[className] = (classCounts[className] ?? 0) + 1;

		if (instance.IsA("LuaSourceContainer")) hasScripts = true;
		if (className === "Animation" || className === "AnimationController" || className === "Animator") hasAnimations = true;
		if (instance.IsA("Sound")) hasSounds = true;
		if (className === "ParticleEmitter" || className === "Fire" || className === "Smoke" || className === "Sparkles") hasParticles = true;

		const node: Record<string, unknown> = {
			name: instance.Name,
			className,
		};

		if (includeProperties) {
			const props: Record<string, unknown> = {};

			if (instance.IsA("BasePart")) {
				props.size = { x: instance.Size.X, y: instance.Size.Y, z: instance.Size.Z };
				props.position = { x: instance.Position.X, y: instance.Position.Y, z: instance.Position.Z };
				props.material = tostring(instance.Material);
				props.color = `${instance.Color.R}, ${instance.Color.G}, ${instance.Color.B}`;
				props.transparency = instance.Transparency;
				props.anchored = instance.Anchored;
			}

			if (instance.IsA("MeshPart")) {
				const meshPart = instance as MeshPart;
				props.meshId = meshPart.MeshId;
				props.textureId = meshPart.TextureID;
			}

			if (instance.IsA("Model")) {
				const model = instance as Model;
				if (model.PrimaryPart) {
					props.primaryPart = model.PrimaryPart.Name;
				}
			}

			if (instance.IsA("LuaSourceContainer")) {
				const [ok, src] = pcall(() => (instance as unknown as { Source: string }).Source);
				if (ok && src) {
					const preview = string.sub(src, 1, 200);
					props.sourcePreview = preview;
					props.sourceLength = src.size();
				}
			}

			if (className === "Decal" || className === "Texture") {
				const [ok, texId] = pcall(() => (instance as unknown as { Texture: string }).Texture);
				if (ok) props.texture = texId;
			}

			if (instance.IsA("Sound")) {
				props.soundId = (instance as Sound).SoundId;
			}

			// Only include props if there are any
			let hasProps = false;
			for (const _ of pairs(props)) {
				hasProps = true;
				break;
			}
			if (hasProps) {
				node.properties = props;
			}
		}

		if (depth < maxDepth) {
			const childNodes: Record<string, unknown>[] = [];
			for (const child of instance.GetChildren()) {
				childNodes.push(buildHierarchy(child, depth + 1));
			}
			if (childNodes.size() > 0) {
				node.children = childNodes;
			}
		} else {
			const childCount = instance.GetChildren().size();
			if (childCount > 0) {
				node.childCount = childCount;
				node.truncated = true;
			}
		}

		return node;
	}

	const [previewSuccess, previewResult] = pcall(() => {
		const hierarchyRoots: Record<string, unknown>[] = [];
		for (const child of (wrapperModel as Instance).GetChildren()) {
			hierarchyRoots.push(buildHierarchy(child, 0));
		}

		return {
			success: true,
			assetId,
			hierarchy: hierarchyRoots,
			summary: {
				totalInstances,
				classCounts,
				hasScripts,
				hasAnimations,
				hasSounds,
				hasParticles,
			},
		};
	});

	pcall(() => {
		(wrapperModel as Instance).Destroy();
	});

	if (!previewSuccess) {
		return { error: `Failed to preview asset ${assetId}: ${tostring(previewResult)}` };
	}

	return previewResult;
}

export = {
	insertAsset,
	previewAsset,
};
