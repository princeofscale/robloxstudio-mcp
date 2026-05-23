interface VIMethods {
	SendMouseButtonEvent(x: number, y: number, button: number, isDown: boolean): void;
	SendMouseMoveEvent(x: number, y: number): void;
	SendMouseWheelEvent(x: number, y: number, isForward: boolean): void;
	SendKeyEvent(isPressed: boolean, keyCode: Enum.KeyCode, isRepeatedKey: boolean): void;
}

function getVIM(): VIMethods | undefined {
	const [ok, result] = pcall(() => {
		return (game as unknown as { GetService(name: string): Instance }).GetService("VirtualInputManager");
	});
	if (ok && result) return result as unknown as VIMethods;
	return undefined;
}

const BUTTON_MAP: Record<string, number> = { Left: 0, Right: 1, Middle: 2 };

function simulateMouseInput(requestData: Record<string, unknown>) {
	const action = requestData.action as string;
	const x = requestData.x as number | undefined;
	const y = requestData.y as number | undefined;
	const button = (requestData.button as string) ?? "Left";
	const scrollDirection = requestData.scrollDirection as string | undefined;

	if (!action) return { error: "action is required" };

	const vim = getVIM();
	if (!vim) return { error: "VirtualInputManager is not available in this context" };

	const buttonNum = BUTTON_MAP[button] ?? 0;

	const [success, err] = pcall(() => {
		if (action === "click") {
			if (x === undefined || y === undefined) error("x and y are required for click");
			vim.SendMouseButtonEvent(x, y, buttonNum, true);
			task.wait(0.05);
			vim.SendMouseButtonEvent(x, y, buttonNum, false);
		} else if (action === "mouseDown") {
			if (x === undefined || y === undefined) error("x and y are required for mouseDown");
			vim.SendMouseButtonEvent(x, y, buttonNum, true);
		} else if (action === "mouseUp") {
			if (x === undefined || y === undefined) error("x and y are required for mouseUp");
			vim.SendMouseButtonEvent(x, y, buttonNum, false);
		} else if (action === "move") {
			if (x === undefined || y === undefined) error("x and y are required for move");
			vim.SendMouseMoveEvent(x, y);
		} else if (action === "scroll") {
			if (x === undefined || y === undefined) error("x and y are required for scroll");
			if (!scrollDirection) error("scrollDirection is required for scroll");
			vim.SendMouseWheelEvent(x, y, scrollDirection === "up");
		} else {
			error(`Unknown action: ${action}`);
		}
	});

	if (success) {
		return { success: true, action, x, y, button };
	}
	return { error: `Failed to simulate mouse input: ${err}` };
}

function simulateKeyboardInput(requestData: Record<string, unknown>) {
	const keyCodeName = requestData.keyCode as string;
	const action = (requestData.action as string) ?? "tap";
	const duration = (requestData.duration as number) ?? 0.1;

	if (!keyCodeName) return { error: "keyCode is required" };

	const vim = getVIM();
	if (!vim) return { error: "VirtualInputManager is not available in this context" };

	const [enumOk, keyCode] = pcall(() => {
		return (Enum.KeyCode as unknown as Record<string, Enum.KeyCode>)[keyCodeName];
	});
	if (!enumOk || !keyCode) {
		return { error: `Unknown keyCode: ${keyCodeName}. Use Enum.KeyCode names like "W", "Space", "E", "LeftShift", etc.` };
	}

	const [success, err] = pcall(() => {
		if (action === "press") {
			vim.SendKeyEvent(true, keyCode, false);
		} else if (action === "release") {
			vim.SendKeyEvent(false, keyCode, false);
		} else if (action === "tap") {
			vim.SendKeyEvent(true, keyCode, false);
			task.wait(duration);
			vim.SendKeyEvent(false, keyCode, false);
		} else {
			error(`Unknown action: ${action}`);
		}
	});

	if (success) {
		return { success: true, keyCode: keyCodeName, action };
	}
	return { error: `Failed to simulate keyboard input: ${err}` };
}

export = {
	simulateMouseInput,
	simulateKeyboardInput,
};
