const ScriptEditorService = game.GetService("ScriptEditorService");

function safeCall<T>(func: (...args: never[]) => T, ...args: never[]): T | undefined {
	const [success, result] = pcall(func, ...args);
	if (success) {
		return result;
	} else {
		warn(`MCP Plugin Error: ${result}`);
		return undefined;
	}
}

function getInstancePath(instance: Instance): string {
	if (!instance || instance === game) {
		return "game";
	}

	const pathParts: string[] = [];
	let current: Instance | undefined = instance;

	while (current && current !== game) {
		pathParts.unshift(current.Name);
		current = current.Parent as Instance | undefined;
	}

	return `game.${pathParts.join(".")}`;
}

function getInstanceByPath(path: string): Instance | undefined {
	if (path === "game" || path === "") {
		return game;
	}

	const cleaned = path.gsub("^game%.", "")[0];
	const parts: string[] = [];
	for (const [part] of cleaned.gmatch("[^%.]+")) {
		parts.push(part as string);
	}

	let current: Instance | undefined = game;
	for (const part of parts) {
		if (!current) return undefined;
		current = current.FindFirstChild(part);
	}

	return current;
}

function splitLines(source: string): LuaTuple<[string[], boolean]> {
	const normalized = ((source ?? "") as string).gsub("\r\n", "\n")[0].gsub("\r", "\n")[0];
	const endsWithNewline = normalized.sub(-1) === "\n";

	const lines: string[] = [];
	let start = 1;

	while (true) {
		const [newlinePos] = string.find(normalized, "\n", start, true);
		if (newlinePos !== undefined) {
			lines.push(string.sub(normalized, start, newlinePos - 1));
			start = newlinePos + 1;
		} else {
			const remainder = string.sub(normalized, start);
			if (remainder !== "" || !endsWithNewline) {
				lines.push(remainder);
			}
			break;
		}
	}

	if (lines.size() === 0) {
		lines.push("");
	}

	return [lines, endsWithNewline] as unknown as LuaTuple<[string[], boolean]>;
}

function joinLines(lines: string[], hadTrailingNewline: boolean): string {
	let source = lines.join("\n");
	if (hadTrailingNewline && source.sub(-1) !== "\n") {
		source += "\n";
	}
	return source;
}

function readScriptSource(instance: LuaSourceContainer): string {
	const [ok, result] = pcall(() => {
		const doc = ScriptEditorService.FindScriptDocument(instance);
		if (doc) {
			return doc.GetText();
		}
		return undefined;
	});
	if (ok && result) {
		return result;
	}
	return (instance as unknown as { Source: string }).Source;
}

function convertPropertyValue(instance: Instance, propertyName: string, propertyValue: unknown): unknown {
	if (propertyValue === undefined) return undefined;

	const inst = instance as unknown as Record<string, unknown>;

	if (typeIs(propertyValue, "table")) {
		const arr = propertyValue as unknown[];
		const tbl = propertyValue as Record<string, unknown>;

		if (typeIs(arr, "table") && (arr as defined[]).size() > 0) {
			const len = (arr as defined[]).size();

			if (len === 3) {
				const prop = propertyName.lower();
				if (
					prop === "position" || prop === "size" || prop === "orientation" ||
					prop === "velocity" || prop === "angularvelocity"
				) {
					return new Vector3(
						(arr[0] as number) ?? 0,
						(arr[1] as number) ?? 0,
						(arr[2] as number) ?? 0,
					);
				} else if (prop === "color" || prop === "color3") {
					return new Color3(
						(arr[0] as number) ?? 0,
						(arr[1] as number) ?? 0,
						(arr[2] as number) ?? 0,
					);
				} else {
					const [success, currentVal] = pcall(() => inst[propertyName]);
					if (success) {
						if (typeOf(currentVal) === "Vector3") {
							return new Vector3(
								(arr[0] as number) ?? 0,
								(arr[1] as number) ?? 0,
								(arr[2] as number) ?? 0,
							);
						} else if (typeOf(currentVal) === "Color3") {
							return new Color3(
								(arr[0] as number) ?? 0,
								(arr[1] as number) ?? 0,
								(arr[2] as number) ?? 0,
							);
						}
					}
				}
			} else if (len === 2) {
				const [success, currentVal] = pcall(() => inst[propertyName]);
				if (success && typeOf(currentVal) === "Vector2") {
					return new Vector2((arr[0] as number) ?? 0, (arr[1] as number) ?? 0);
				}
			} else if (len === 4) {
				const [success, currentVal] = pcall(() => inst[propertyName]);
				if (success && typeOf(currentVal) === "UDim2") {
					return new UDim2(
						(arr[0] as number) ?? 0,
						(arr[1] as number) ?? 0,
						(arr[2] as number) ?? 0,
						(arr[3] as number) ?? 0,
					);
				}
			}
		}

		if (tbl.X !== undefined || tbl.Y !== undefined || tbl.Z !== undefined) {

			if (typeIs(tbl.X, "table") && typeIs(tbl.Y, "table")) {
				const xTbl = tbl.X as unknown as Record<string, number>;
				const yTbl = tbl.Y as unknown as Record<string, number>;
				return new UDim2(
					xTbl.Scale ?? 0, xTbl.Offset ?? 0,
					yTbl.Scale ?? 0, yTbl.Offset ?? 0,
				);
			}
			return new Vector3(
				(tbl.X as number) ?? 0,
				(tbl.Y as number) ?? 0,
				(tbl.Z as number) ?? 0,
			);
		}

		if (tbl.R !== undefined || tbl.G !== undefined || tbl.B !== undefined) {
			return new Color3(
				(tbl.R as number) ?? 0,
				(tbl.G as number) ?? 0,
				(tbl.B as number) ?? 0,
			);
		}
	}

	if (typeIs(propertyValue, "string")) {
		const [success, currentVal] = pcall(() => inst[propertyName]);
		if (success && typeOf(currentVal) === "EnumItem") {
			const enumItem = currentVal as EnumItem;
			const enumTypeName = tostring(enumItem.EnumType);
			const [enumSuccess, enumVal] = pcall(() => {
				return (Enum as unknown as Record<string, Record<string, EnumItem>>)[enumTypeName][propertyValue];
			});
			if (enumSuccess && enumVal) return enumVal;
		}
		if (propertyName === "BrickColor") {
			return new BrickColor(propertyValue as unknown as number);
		}
		if (propertyValue === "true") return true;
		if (propertyValue === "false") return false;
	}

	return propertyValue;
}

function evaluateFormula(
	formula: string,
	variables: Record<string, unknown> | undefined,
	instance: Instance | undefined,
	index: number,
): LuaTuple<[number, string | undefined]> {
	let value = formula;

	value = value.gsub("index", tostring(index))[0];

	if (instance && instance.IsA("BasePart")) {
		const pos = instance.Position;
		const sz = instance.Size;
		value = value.gsub("Position%.X", tostring(pos.X))[0];
		value = value.gsub("Position%.Y", tostring(pos.Y))[0];
		value = value.gsub("Position%.Z", tostring(pos.Z))[0];
		value = value.gsub("Size%.X", tostring(sz.X))[0];
		value = value.gsub("Size%.Y", tostring(sz.Y))[0];
		value = value.gsub("Size%.Z", tostring(sz.Z))[0];
		value = value.gsub("magnitude", tostring(pos.Magnitude))[0];
	}

	if (variables) {
		for (const [k, v] of pairs(variables)) {
			value = value.gsub(k as string, tostring(v))[0];
		}
	}

	value = value.gsub("sin%(([%d%.%-]+)%)", (x: string) => tostring(math.sin(tonumber(x) ?? 0)))[0];
	value = value.gsub("cos%(([%d%.%-]+)%)", (x: string) => tostring(math.cos(tonumber(x) ?? 0)))[0];
	value = value.gsub("sqrt%(([%d%.%-]+)%)", (x: string) => tostring(math.sqrt(tonumber(x) ?? 0)))[0];
	value = value.gsub("abs%(([%d%.%-]+)%)", (x: string) => tostring(math.abs(tonumber(x) ?? 0)))[0];
	value = value.gsub("floor%(([%d%.%-]+)%)", (x: string) => tostring(math.floor(tonumber(x) ?? 0)))[0];
	value = value.gsub("ceil%(([%d%.%-]+)%)", (x: string) => tostring(math.ceil(tonumber(x) ?? 0)))[0];

	const directResult = tonumber(value);
	if (directResult !== undefined) {
		return [directResult, undefined] as unknown as LuaTuple<[number, string | undefined]>;
	}

	const [success, evalResult] = pcall(() => {
		const num = tonumber(value);
		if (num !== undefined) return num;

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*%*%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) return (tonumber(a) ?? 0) * (tonumber(b) ?? 0);
		}

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*%+%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) return (tonumber(a) ?? 0) + (tonumber(b) ?? 0);
		}

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*%-%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) return (tonumber(a) ?? 0) - (tonumber(b) ?? 0);
		}

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*/%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) {
				const divisor = tonumber(b) ?? 1;
				if (divisor !== 0) return (tonumber(a) ?? 0) / divisor;
			}
		}

		error(`Unsupported formula pattern: ${value}`);
	});

	if (success && typeIs(evalResult, "number")) {
		return [evalResult, undefined] as unknown as LuaTuple<[number, string | undefined]>;
	} else {
		return [index, "Complex formulas not supported - using index value"] as unknown as LuaTuple<[number, string | undefined]>;
	}
}

function compareVersions(v1: string, v2: string): number {
	function parseVersion(v: string): number[] {
		const parts: number[] = [];
		for (const [num] of string.gmatch(v, "%d+")) {
			parts.push(tonumber(num) ?? 0);
		}
		return parts;
	}

	const p1 = parseVersion(v1);
	const p2 = parseVersion(v2);
	const maxLen = math.max(p1.size(), p2.size());
	for (let i = 0; i < maxLen; i++) {
		const n1 = p1[i] ?? 0;
		const n2 = p2[i] ?? 0;
		if (n1 < n2) return -1;
		if (n1 > n2) return 1;
	}
	return 0;
}

export = {
	safeCall,
	getInstancePath,
	getInstanceByPath,
	splitLines,
	joinLines,
	readScriptSource,
	convertPropertyValue,
	evaluateFormula,
	compareVersions,
};
