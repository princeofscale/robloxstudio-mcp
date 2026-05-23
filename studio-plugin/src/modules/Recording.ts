const ChangeHistoryService = game.GetService("ChangeHistoryService");

type RecordingId = string | undefined;

function beginRecording(actionName: string): RecordingId {
	const [success, result] = pcall(() => ChangeHistoryService.TryBeginRecording(`MCP: ${actionName}`));
	if (success) {
		return result as RecordingId;
	}
	return undefined;
}

function finishRecording(recordingId: RecordingId, shouldCommit: boolean) {
	if (recordingId === undefined) return;

	const operation = shouldCommit
		? Enum.FinishRecordingOperation.Commit
		: Enum.FinishRecordingOperation.Cancel;

	pcall(() => {
		ChangeHistoryService.FinishRecording(recordingId, operation);
	});
}

export = {
	beginRecording,
	finishRecording,
};
