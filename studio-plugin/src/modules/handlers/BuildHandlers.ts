import Utils from "../Utils";
import Recording from "../Recording";

const MaterialService = game.GetService("MaterialService");

const { getInstancePath, getInstanceByPath } = Utils;
const { beginRecording, finishRecording } = Recording;

const MATERIAL_BY_NAME = new Map<string, Enum.Material>();
for (const enumItem of Enum.Material.GetEnumItems()) {
	MATERIAL_BY_NAME.set(enumItem.Name, enumItem as unknown as Enum.Material);
}

// Shape class mapping
const SHAPE_CLASSES: Record<string, string> = {
	Block: "Part",
	Wedge: "WedgePart",
	Cylinder: "Part",
	Ball: "Part",
	CornerWedge: "CornerWedgePart",
};

const PALETTE_KEYS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function roundTo(n: number, decimals: number): number {
	const mult = 10 ** decimals;
	return math.round(n * mult) / mult;
}

function encodePaletteKey(index: number): string {
	const base = PALETTE_KEYS.size();
	let value = math.floor(index) + 1;
	let encoded = "";
	while (value > 0) {
		value -= 1;
		const digit = value % base;
		encoded = PALETTE_KEYS.sub(digit + 1, digit + 1) + encoded;
		value = math.floor(value / base);
	}
	return encoded;
}

function getVariantName(part: BasePart): string {
	let variantName = part.MaterialVariant;
	if (variantName === "") {
		const [ok, variantAttr] = pcall(() => part.GetAttribute("MaterialVariant"));
		if (ok && type(variantAttr) === "string") {
			variantName = variantAttr as string;
		}
	}
	return variantName;
}

function exportBuild(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const outputId = requestData.outputId as string;
	const style = (requestData.style as string) ?? "misc";

	if (!instancePath) {
		return { error: "Instance path is required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };

	if (!instance.IsA("Model") && !instance.IsA("Folder")) {
		return { error: "Instance must be a Model or Folder" };
	}

	const [success, result] = pcall(() => {
		const descendants = instance.GetDescendants();
		const baseParts: BasePart[] = [];
		for (const desc of descendants) {
			if (desc.IsA("BasePart")) {
				baseParts.push(desc);
			}
		}

		if (baseParts.size() === 0) {
			return { error: "No BaseParts found in instance" };
		}

		// Compute bounding box center
		let minX = math.huge;
		let minY = math.huge;
		let minZ = math.huge;
		let maxX = -math.huge;
		let maxY = -math.huge;
		let maxZ = -math.huge;

		for (const part of baseParts) {
			const pos = part.Position;
			const sz = part.Size;
			const halfX = sz.X / 2;
			const halfY = sz.Y / 2;
			const halfZ = sz.Z / 2;
			minX = math.min(minX, pos.X - halfX);
			minY = math.min(minY, pos.Y - halfY);
			minZ = math.min(minZ, pos.Z - halfZ);
			maxX = math.max(maxX, pos.X + halfX);
			maxY = math.max(maxY, pos.Y + halfY);
			maxZ = math.max(maxZ, pos.Z + halfZ);
		}

		const centerX = (minX + maxX) / 2;
		const centerY = minY; // Use bottom as Y origin
		const centerZ = (minZ + maxZ) / 2;
		const boundsX = roundTo(maxX - minX, 1);
		const boundsY = roundTo(maxY - minY, 1);
		const boundsZ = roundTo(maxZ - minZ, 1);

		// Build palette from unique (BrickColor, Material, MaterialVariant?) combos
		const paletteMap = new Map<string, string>();
		const palette: Record<string, [string, string] | [string, string, string]> = {};
		let keyIndex = 0;

		for (const part of baseParts) {
			const colorName = part.BrickColor.Name;
			const materialName = part.Material.Name;
			const variantName = getVariantName(part);
			const combo = variantName !== "" ? `${colorName}|${materialName}|${variantName}` : `${colorName}|${materialName}`;

			if (!paletteMap.has(combo)) {
				const key = encodePaletteKey(keyIndex);
				keyIndex++;
				paletteMap.set(combo, key);
				if (variantName !== "") {
					palette[key] = [colorName, materialName, variantName];
				} else {
					palette[key] = [colorName, materialName];
				}
			}
		}

		// Build compact part arrays
		const parts: unknown[][] = [];
		for (const part of baseParts) {
			const pos = part.Position;
			const orient = part.Orientation;
			const sz = part.Size;
			const colorName = part.BrickColor.Name;
			const materialName = part.Material.Name;
			const variantName = getVariantName(part);
			const combo = variantName !== "" ? `${colorName}|${materialName}|${variantName}` : `${colorName}|${materialName}`;
			const paletteKey = paletteMap.get(combo) ?? "a";

			// Relative position to center
			const relX = roundTo(pos.X - centerX, 1);
			const relY = roundTo(pos.Y - centerY, 1);
			const relZ = roundTo(pos.Z - centerZ, 1);
			const sizeX = roundTo(sz.X, 1);
			const sizeY = roundTo(sz.Y, 1);
			const sizeZ = roundTo(sz.Z, 1);
			const rotX = roundTo(orient.X, 1);
			const rotY = roundTo(orient.Y, 1);
			const rotZ = roundTo(orient.Z, 1);

			// Determine shape
			let shape = "Block";
			if (part.IsA("WedgePart")) {
				shape = "Wedge";
			} else if (part.IsA("CornerWedgePart")) {
				shape = "CornerWedge";
			} else if (part.IsA("Part")) {
				const p = part as Part;
				if (p.Shape === Enum.PartType.Cylinder) {
					shape = "Cylinder";
				} else if (p.Shape === Enum.PartType.Ball) {
					shape = "Ball";
				}
			}

			// Build part array with optional trailing fields
			const hasTransparency = part.Transparency > 0;
			const hasShape = shape !== "Block";

			let partArr: defined[];
			if (hasTransparency) {
				partArr = [relX, relY, relZ, sizeX, sizeY, sizeZ, rotX, rotY, rotZ, paletteKey, hasShape ? shape : "Block", roundTo(part.Transparency, 2)];
			} else if (hasShape) {
				partArr = [relX, relY, relZ, sizeX, sizeY, sizeZ, rotX, rotY, rotZ, paletteKey, shape];
			} else {
				partArr = [relX, relY, relZ, sizeX, sizeY, sizeZ, rotX, rotY, rotZ, paletteKey];
			}

			parts.push(partArr);
		}

		const buildId = outputId ?? `${style}/${instance.Name.lower().gsub(" ", "_")[0]}`;

		return {
			success: true,
			buildData: {
				id: buildId,
				style: style,
				bounds: [boundsX, boundsY, boundsZ],
				palette: palette,
				parts: parts,
			},
		};
	});

	if (success && result) {
		return result;
	} else {
		return { error: `Failed to export build: ${result}` };
	}
}

function importBuild(requestData: Record<string, unknown>) {
	const buildData = requestData.buildData as Record<string, unknown>;
	const targetPath = requestData.targetPath as string;
	const positionOffset = (requestData.position as number[]) ?? [0, 0, 0];

	if (!buildData || !targetPath) {
		return { error: "buildData and targetPath are required" };
	}

	const parentInstance = getInstanceByPath(targetPath);
	if (!parentInstance) return { error: `Target not found: ${targetPath}` };
	const recordingId = beginRecording("Import build");

	const [success, result] = pcall(() => {
		const palette = buildData.palette as Record<string, [string, string, string?]>;
		const parts = buildData.parts as unknown[][];
		const buildId = (buildData.id as string) ?? "imported_build";

		// Create model container
		const model = new Instance("Model");
		model.Name = buildId.match("[^/]+$")[0] as string ?? buildId;

		let partCount = 0;

		for (const partArr of parts) {
			const posX = (partArr[0] as number) + (positionOffset[0] ?? 0);
			const posY = (partArr[1] as number) + (positionOffset[1] ?? 0);
			const posZ = (partArr[2] as number) + (positionOffset[2] ?? 0);
			const sizeX = partArr[3] as number;
			const sizeY = partArr[4] as number;
			const sizeZ = partArr[5] as number;
			const rotX = partArr[6] as number;
			const rotY = partArr[7] as number;
			const rotZ = partArr[8] as number;
			const paletteKey = partArr[9] as string;
			const shape = (partArr[10] as string) ?? "Block";
			const transparency = (partArr[11] as number) ?? 0;

			// Determine class from shape
			const className = SHAPE_CLASSES[shape] ?? "Part";
			const part = new Instance(className as keyof CreatableInstances) as BasePart;

			// Set shape for Part instances with non-Block shapes
			if (className === "Part" && shape !== "Block") {
				if (shape === "Cylinder") {
					(part as Part).Shape = Enum.PartType.Cylinder;
				} else if (shape === "Ball") {
					(part as Part).Shape = Enum.PartType.Ball;
				}
			}

			part.Size = new Vector3(sizeX, sizeY, sizeZ);
			part.Position = new Vector3(posX, posY, posZ);
			part.Orientation = new Vector3(rotX, rotY, rotZ);
			part.Anchored = true;

			if (transparency > 0) {
				part.Transparency = transparency;
			}

			// Apply palette
			const paletteEntry = palette[paletteKey];
			if (paletteEntry) {
				const [colorName, materialName, variantName] = paletteEntry;
				pcall(() => {
					part.BrickColor = new BrickColor(colorName as unknown as number);
				});
				pcall(() => {
					const mat = MATERIAL_BY_NAME.get(materialName);
					if (mat !== undefined) {
						part.Material = mat;
					}
				});
				// Apply MaterialVariant if specified
				if (variantName !== undefined && variantName !== "") {
					pcall(() => {
						part.MaterialVariant = variantName;
					});
				}
			}

			part.Parent = model;
			partCount++;
		}

		model.Parent = parentInstance;

		return {
			success: true,
			partCount: partCount,
			modelPath: getInstancePath(model),
		};
	});

	if (success && result) {
		finishRecording(recordingId, true);
		return result;
	} else {
		finishRecording(recordingId, false);
		return { error: `Failed to import build: ${result}` };
	}
}

function importScene(requestData: Record<string, unknown>) {
	const expandedBuilds = requestData.expandedBuilds as Record<string, unknown>[];
	const targetPath = (requestData.targetPath as string) ?? "game.Workspace";

	if (!expandedBuilds || !typeIs(expandedBuilds, "table") || (expandedBuilds as defined[]).size() === 0) {
		return { error: "expandedBuilds array is required" };
	}

	const parentInstance = getInstanceByPath(targetPath);
	if (!parentInstance) return { error: `Target not found: ${targetPath}` };
	const recordingId = beginRecording("Import scene");

	const [success, result] = pcall(() => {
		let modelCount = 0;
		let totalParts = 0;
		const models: Record<string, unknown>[] = [];

		for (const entry of expandedBuilds) {
			const buildData = entry.buildData as Record<string, unknown>;
			const position = (entry.position as number[]) ?? [0, 0, 0];
			const rotation = (entry.rotation as number[]) ?? [0, 0, 0];
			const name = (entry.name as string) ?? "SceneModel";

			const palette = buildData.palette as Record<string, [string, string, string?]>;
			const parts = buildData.parts as unknown[][];

			const model = new Instance("Model");
			model.Name = name;

			const rotCF = CFrame.Angles(
				math.rad(rotation[0] ?? 0),
				math.rad(rotation[1] ?? 0),
				math.rad(rotation[2] ?? 0),
			);
			const originCF = new CFrame(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0).mul(rotCF);

			let partCount = 0;

			for (const partArr of parts) {
				const localX = partArr[0] as number;
				const localY = partArr[1] as number;
				const localZ = partArr[2] as number;
				const sizeX = partArr[3] as number;
				const sizeY = partArr[4] as number;
				const sizeZ = partArr[5] as number;
				const rotX = partArr[6] as number;
				const rotY = partArr[7] as number;
				const rotZ = partArr[8] as number;
				const paletteKey = partArr[9] as string;
				const shape = (partArr[10] as string) ?? "Block";
				const transparency = (partArr[11] as number) ?? 0;

				const className = SHAPE_CLASSES[shape] ?? "Part";
				const part = new Instance(className as keyof CreatableInstances) as BasePart;

				if (className === "Part" && shape !== "Block") {
					if (shape === "Cylinder") {
						(part as Part).Shape = Enum.PartType.Cylinder;
					} else if (shape === "Ball") {
						(part as Part).Shape = Enum.PartType.Ball;
					}
				}

				part.Size = new Vector3(sizeX, sizeY, sizeZ);

				// Apply local rotation then world transform
				const localRotCF = CFrame.Angles(math.rad(rotX), math.rad(rotY), math.rad(rotZ));
				const localPosCF = new CFrame(localX, localY, localZ).mul(localRotCF);
				const worldCF = originCF.mul(localPosCF);

				part.CFrame = worldCF;
				part.Anchored = true;

				if (transparency > 0) {
					part.Transparency = transparency;
				}

				const paletteEntry = palette[paletteKey];
				if (paletteEntry) {
					const [colorName, materialName, variantName] = paletteEntry;
					pcall(() => {
						part.BrickColor = new BrickColor(colorName as unknown as number);
					});
					pcall(() => {
						const mat = MATERIAL_BY_NAME.get(materialName);
						if (mat !== undefined) {
							part.Material = mat;
						}
					});
					if (variantName !== undefined && variantName !== "") {
						pcall(() => {
							part.MaterialVariant = variantName;
						});
					}
				}

				part.Parent = model;
				partCount++;
			}

			model.Parent = parentInstance;
			modelCount++;
			totalParts += partCount;
			models.push({
				name: name,
				partCount: partCount,
				modelPath: getInstancePath(model),
			});
		}

		return {
			success: true,
			modelCount: modelCount,
			totalParts: totalParts,
			models: models,
		};
	});

	if (success && result) {
		finishRecording(recordingId, true);
		return result;
	} else {
		finishRecording(recordingId, false);
		return { error: `Failed to import scene: ${result}` };
	}
}

function searchMaterials(requestData: Record<string, unknown>) {
	const query = ((requestData.query as string) ?? "").lower();
	const maxResults = (requestData.maxResults as number) ?? 50;

	const [success, result] = pcall(() => {
		const children = MaterialService.GetChildren();
		const materials: Record<string, unknown>[] = [];

		for (const child of children) {
			if (!child.IsA("MaterialVariant")) continue;

			const nameMatch = query === "" || child.Name.lower().find(query)[0] !== undefined;
			if (!nameMatch) continue;

			materials.push({
				name: child.Name,
				baseMaterial: child.BaseMaterial.Name,
			});

			if (materials.size() >= maxResults) break;
		}

		return {
			success: true,
			materials: materials,
			total: materials.size(),
		};
	});

	if (success && result) {
		return result;
	} else {
		return { error: `Failed to search materials: ${result}` };
	}
}

export = {
	exportBuild,
	importBuild,
	importScene,
	searchMaterials,
};
