using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Win32;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VsClineAgent.Agent;
using VsClineAgent.Agent.Models;
using VsClineAgent.Services;

namespace VsClineAgent.Bridge
{
    internal sealed class VisualStudioClineBridge
    {
        private readonly AgentController _agentController;
        private readonly SettingsService _settingsService;
        private readonly VsEditorService _editorService;
        private readonly VsCommandExecutionService _commandService;
        private readonly Func<object, Task> _postToWebviewAsync;
        private readonly Dictionary<string, GrpcSubscription> _subscriptions = new Dictionary<string, GrpcSubscription>();
        private readonly Dictionary<string, TaskSnapshot> _taskSnapshots = new Dictionary<string, TaskSnapshot>();
        private readonly Dictionary<string, CheckpointSession> _checkpointSessions = new Dictionary<string, CheckpointSession>();

        private JObject _state = new JObject();
        private string _workspaceRoot = "";
        private string _currentTaskText = "";
        private string? _currentTaskId;
        private string? _pendingAskType;
        private List<ChatMessage>? _checkpointResumeHistorySeed;
        private long _messageSequence;
        private bool _apiRequestInProgress;
        private bool _currentTaskCompleted;

        public VisualStudioClineBridge(
            AgentController agentController,
            SettingsService settingsService,
            VsEditorService editorService,
            Func<object, Task> postToWebviewAsync)
        {
            _agentController = agentController;
            _settingsService = settingsService;
            _editorService = editorService;
            _commandService = new VsCommandExecutionService();
            _postToWebviewAsync = postToWebviewAsync;
            _agentController.AgentEvent += OnAgentEvent;
        }

        public async Task InitializeAsync()
        {
            _workspaceRoot = await _editorService.GetSolutionRootAsync() ?? "";
            _state = CreateInitialState(_settingsService.Load(), _workspaceRoot);
        }

        public async Task HandleWebMessageAsync(string rawJson)
        {
            var envelope = JObject.Parse(rawJson);
            var type = envelope.Value<string>("type") ?? "";

            switch (type)
            {
                case "grpc_request":
                    var grpcRequest = envelope["grpc_request"] as JObject;
                    if (grpcRequest != null)
                    {
                        await HandleGrpcRequestAsync(grpcRequest);
                    }
                    break;
                case "grpc_request_cancel":
                    var cancel = envelope["grpc_request_cancel"] as JObject;
                    if (cancel != null)
                    {
                        var requestId = cancel.Value<string>("request_id");
                        if (!string.IsNullOrWhiteSpace(requestId))
                        {
                            _subscriptions.Remove(requestId);
                        }
                    }
                    break;
            }
        }

        private async Task HandleGrpcRequestAsync(JObject request)
        {
            var service = request.Value<string>("service") ?? "";
            var method = request.Value<string>("method") ?? "";
            var requestId = request.Value<string>("request_id") ?? "";
            var message = request["message"] as JObject ?? new JObject();
            var isStreaming = request.Value<bool?>("is_streaming") == true;

            if (string.IsNullOrWhiteSpace(requestId))
            {
                return;
            }

            try
            {
                if (isStreaming)
                {
                    _subscriptions[requestId] = new GrpcSubscription(requestId, service, method);
                    await HandleStreamingRequestAsync(service, method, requestId, message);
                    return;
                }

                var response = await HandleUnaryRequestAsync(service, method, message);
                await SendUnaryResponseAsync(requestId, response);
            }
            catch (Exception ex)
            {
                await SendErrorResponseAsync(requestId, ex.Message);
            }
        }

        private async Task HandleStreamingRequestAsync(string service, string method, string requestId, JObject message)
        {
            switch ($"{service}.{method}")
            {
                case "StateService.subscribeToState":
                    await SendStreamingResponseAsync(requestId, new JObject
                    {
                        ["stateJson"] = _state.ToString()
                    });
                    break;
                case "McpService.subscribeToMcpMarketplaceCatalog":
                case "McpService.subscribeToMcpServers":
                case "ModelsService.subscribeToOpenRouterModels":
                case "ModelsService.subscribeToLiteLlmModels":
                    break;
                case "AccountService.subscribeToAuthStatusUpdate":
                    await SendStreamingResponseAsync(requestId, CreateUnauthenticatedAuthStateResponse());
                    break;
                case "OcaAccountService.ocaSubscribeToAuthStatusUpdate":
                    await SendStreamingResponseAsync(requestId, CreateUnauthenticatedOcaAuthStateResponse());
                    break;
                // The webview eagerly subscribes to these UI event streams during startup.
                // Upstream backs them with host-side senders, but the Visual Studio port does not.
                // Keep them registered but silent for now so startup does not degrade into guaranteed stream errors.
                case "UiService.subscribeToMcpButtonClicked":
                case "UiService.subscribeToHistoryButtonClicked":
                case "UiService.subscribeToChatButtonClicked":
                case "UiService.subscribeToSettingsButtonClicked":
                case "UiService.subscribeToWorktreesButtonClicked":
                case "UiService.subscribeToPartialMessage":
                case "UiService.subscribeToAccountButtonClicked":
                case "UiService.subscribeToRelinquishControl":
                case "UiService.subscribeToShowWebview":
                case "UiService.subscribeToAddToInput":
                    break;
                default:
                    if (method.StartsWith("subscribeTo", StringComparison.Ordinal))
                    {
                        break;
                    }

                    await SendStreamingResponseAsync(requestId, new JObject());
                    break;
            }
        }

        private async Task<JToken> HandleUnaryRequestAsync(string service, string method, JObject message)
        {
            switch ($"{service}.{method}")
            {
                case "UiService.initializeWebview":
                    return new JObject();
                case "UiService.onDidShowAnnouncement":
                    return new JObject { ["value"] = false };
                case "UiService.openUrl":
                    OpenExternalUrl(message.Value<string>("url"));
                    return new JObject();
                case "UiService.openWalkthrough":
                    return new JObject();
                case "UiService.setTerminalExecutionMode":
                    return new JObject();
                case "BrowserService.getDetectedChromePath":
                    return GetDetectedChromePathResponse();
                case "BrowserService.getBrowserConnectionInfo":
                    return await GetBrowserConnectionInfoAsync();
                case "BrowserService.testBrowserConnection":
                    return await TestBrowserConnectionAsync(message.Value<string>("value"));
                case "BrowserService.discoverBrowser":
                    return await DiscoverBrowserAsync();
                case "BrowserService.relaunchChromeDebugMode":
                    return RelaunchChromeDebugMode();
                case "CheckpointsService.checkpointRestore":
                    return await HandleCheckpointRestoreAsync(message);
                case "CheckpointsService.checkpointDiff":
                    return await HandleCheckpointDiffAsync(message);
                case "WorktreeService.listWorktrees":
                    return CreateWorktreeListResponse();
                case "WorktreeService.getWorktreeDefaults":
                    return CreateWorktreeDefaultsResponse();
                case "WorktreeService.getWorktreeIncludeStatus":
                    return GetWorktreeIncludeStatusResponse();
                case "WorktreeService.createWorktreeInclude":
                    return CreateWorktreeInclude(message);
                case "WorktreeService.createWorktree":
                    return CreateUnsupportedWorktreeResponse("Worktree creation is owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "WorktreeService.switchWorktree":
                    return CreateUnsupportedWorktreeResponse("Worktree switching is owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "WorktreeService.mergeWorktree":
                    return CreateUnsupportedMergeWorktreeResponse("Worktree merging is owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "WorktreeService.deleteWorktree":
                    return CreateUnsupportedWorktreeResponse("Worktree deletion is owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "WorktreeService.trackWorktreeViewOpened":
                    return new JObject();
                case "WebService.checkIsImageUrl":
                    return new JObject { ["value"] = false };
                case "WebService.fetchOpenGraphData":
                    return new JObject();
                case "WebService.openInBrowser":
                    OpenExternalUrl(message.Value<string>("value") ?? string.Empty);
                    return new JObject();
                case "StateService.getAvailableTerminalProfiles":
                    var profiles = await _commandService.GetAvailableProfilesAsync();
                    return new JObject
                    {
                        ["profiles"] = new JArray(profiles.Select(profile => new JObject
                        {
                            ["id"] = profile.Id,
                            ["name"] = profile.Name,
                        }))
                    };
                case "StateService.updateSettings":
                    ApplyStateSettings(message);
                    await BroadcastStateAsync();
                    return new JObject();
                case "StateService.updateAutoApprovalSettings":
                    ApplyAutoApprovalSettings(message);
                    await BroadcastStateAsync();
                    return new JObject();
                case "StateService.refreshRemoteConfig":
                    return CreateUnsupportedStateOperationResponse("Remote config refresh is not implemented in the Visual Studio port.");
                case "StateService.testOtelConnection":
                    return CreateUnsupportedStateOperationResponse("OpenTelemetry testing is not implemented in the Visual Studio port.");
                case "StateService.testPromptUploading":
                    return CreateUnsupportedStateOperationResponse("Prompt upload testing is not implemented in the Visual Studio port.");
                case "StateService.toggleFavoriteModel":
                    return CreateUnsupportedStateOperationResponse("Favorite model persistence is not implemented in the Visual Studio port.");
                case "StateService.captureOnboardingProgress":
                    return CreateUnsupportedStateOperationResponse("Onboarding telemetry capture is not implemented in the Visual Studio port.");
                case "StateService.togglePlanActModeProto":
                    return new JObject { ["value"] = true };
                case "StateService.updateTelemetrySetting":
                    return CreateUnsupportedStateOperationResponse("Telemetry setting updates are not implemented in the Visual Studio port.");
                case "StateService.dismissBanner":
                    return CreateUnsupportedStateOperationResponse("Banner dismissal is not implemented in the Visual Studio port.");
                case "StateService.installClineCli":
                    return CreateUnsupportedStateOperationResponse("Cline CLI installation is not implemented in the Visual Studio port.");
                case "StateService.updateInfoBannerVersion":
                    return CreateUnsupportedStateOperationResponse("Info banner version persistence is not implemented in the Visual Studio port.");
                case "StateService.updateModelBannerVersion":
                    return CreateUnsupportedStateOperationResponse("Model banner version persistence is not implemented in the Visual Studio port.");
                case "StateService.updateCliBannerVersion":
                    return CreateUnsupportedStateOperationResponse("CLI banner version persistence is not implemented in the Visual Studio port.");
                case "StateService.updateTerminalConnectionTimeout":
                    return UpdateTerminalConnectionTimeout(message);
                case "StateService.setWelcomeViewCompleted":
                    _state["welcomeViewCompleted"] = message.Value<bool?>("value") ?? true;
                    await BroadcastStateAsync();
                    return new JObject();
                case "StateService.resetState":
                    ClearCurrentTask(preserveHistory: true);
                    await BroadcastStateAsync();
                    return new JObject();
                case "ModelsService.updateApiConfigurationProto":
                case "ModelsService.updateApiConfiguration":
                    ApplyApiConfiguration(message);
                    await BroadcastStateAsync();
                    return new JObject();
                case "ModelsService.getOllamaModels":
                case "ModelsService.getVsCodeLmModels":
                case "ModelsService.getSapAiCoreModels":
                case "ModelsService.getLmStudioModels":
                case "ModelsService.getAihubmixModels":
                case "ModelsService.refreshOpenAiModels":
                case "ModelsService.refreshOcaModels":
                    return new JObject
                    {
                        ["models"] = new JArray
                        {
                            new JObject
                            {
                                ["id"] = _settingsService.Load().ModelName,
                                ["name"] = _settingsService.Load().ModelName
                            }
                        }
                    };
                case "ModelsService.refreshOpenRouterModelsRpc":
                case "ModelsService.refreshLiteLlmModelsRpc":
                case "ModelsService.refreshHicapModels":
                case "ModelsService.refreshBasetenModelsRpc":
                case "ModelsService.refreshVercelAiGatewayModelsRpc":
                case "ModelsService.refreshClineModelsRpc":
                case "ModelsService.refreshRequestyModels":
                case "ModelsService.refreshHuggingFaceModels":
                case "ModelsService.refreshGroqModelsRpc":
                case "ModelsService.refreshClineRecommendedModelsRpc":
                    return CreateCurrentModelCatalog();
                case "McpService.getLatestMcpServers":
                    return CreateEmptyMcpServersResponse();
                case "McpService.refreshMcpMarketplace":
                    return CreateEmptyMcpMarketplaceCatalog();
                case "McpService.addRemoteMcpServer":
                    return CreateUnsupportedMcpServersResponse("MCP server registration is owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "McpService.openMcpSettings":
                    return CreateUnsupportedMcpOperationResponse("MCP settings are owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "McpService.updateMcpTimeout":
                    return CreateUnsupportedMcpServersResponse("MCP server timeout updates are owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "McpService.restartMcpServer":
                    return CreateUnsupportedMcpServersResponse("MCP restart is owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "McpService.deleteMcpServer":
                    return CreateUnsupportedMcpServersResponse("MCP deletion is owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "McpService.toggleToolAutoApprove":
                    return CreateUnsupportedMcpServersResponse("MCP tool auto-approval is owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "McpService.toggleMcpServer":
                    return CreateUnsupportedMcpServersResponse("MCP toggling is owned by the SDK sidecar. If this fallback appears, the sidecar handler did not answer.");
                case "McpService.authenticateMcpServer":
                    return CreateUnsupportedMcpServersResponse("MCP authentication is owned by the SDK sidecar for supported providers. If this fallback appears, the sidecar handler did not answer.");
                case "McpService.downloadMcp":
                    return CreateUnsupportedMcpDownloadResponse("Downloading MCP marketplace entries is not implemented in the Visual Studio port.");
                case "TaskService.newTask":
                    await StartNewTaskAsync(message);
                    return new JObject();
                case "TaskService.askResponse":
                    await HandleAskResponseAsync(message);
                    return new JObject();
                case "TaskService.clearTask":
                    _agentController.Stop();
                    ClearCurrentTask(preserveHistory: true);
                    await BroadcastStateAsync();
                    return new JObject();
                case "TaskService.cancelTask":
                    CancelCurrentTask("Task cancelled.");
                    await BroadcastStateAsync();
                    return new JObject();
                case "TaskService.getTaskHistory":
                    return new JObject
                    {
                        ["tasks"] = new JArray(GetTaskHistory())
                    };
                case "TaskService.getTotalTasksSize":
                    return new JObject
                    {
                        ["value"] = GetTaskHistory().Count
                    };
                case "TaskService.showTaskWithId":
                    await ShowTaskWithIdAsync(message.Value<string>("value"));
                    return new JObject();
                case "TaskService.exportTaskWithId":
                    await OpenDiskConversationHistoryAsync(message.Value<string>("value"));
                    return new JObject();
                case "TaskService.deleteTasksWithIds":
                    DeleteTasks(message["value"] as JArray);
                    await BroadcastStateAsync();
                    return new JObject();
                case "TaskService.deleteAllTaskHistory":
                    _taskSnapshots.Clear();
                    ((JArray)_state["taskHistory"]).RemoveAll();
                    await BroadcastStateAsync();
                    return new JObject();
                case "TaskService.toggleTaskFavorite":
                    ToggleTaskFavorite(message.Value<string>("taskId"), message.Value<bool?>("isFavorited") == true);
                    await BroadcastStateAsync();
                    return new JObject();
                case "TaskService.taskFeedback":
                    return new JObject();
                case "TaskService.taskCompletionViewChanges":
                    return await HandleTaskCompletionViewChangesAsync(message);
                case "TaskService.explainChanges":
                    return await HandleExplainChangesAsync(message);
                case "TaskService.cancelBackgroundCommand":
                    _state["backgroundCommandRunning"] = false;
                    _state["backgroundCommandTaskId"] = null;
                    _state["lastCompletedCommandTs"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    await BroadcastStateAsync();
                    return new JObject();
                case "FileService.copyToClipboard":
                    await CopyToClipboardAsync(message.Value<string>("value") ?? "");
                    return new JObject();
                case "FileService.refreshRules":
                    return CreateRulesRefreshResponse();
                case "FileService.toggleClineRule":
                    var toggledClineRule = ToggleClineRule(message);
                    await BroadcastStateAsync();
                    return toggledClineRule;
                case "FileService.toggleCursorRule":
                    var toggledCursorRule = ToggleSimpleRule(message, "localCursorRulesToggles");
                    await BroadcastStateAsync();
                    return toggledCursorRule;
                case "FileService.toggleWindsurfRule":
                    var toggledWindsurfRule = ToggleSimpleRule(message, "localWindsurfRulesToggles");
                    await BroadcastStateAsync();
                    return toggledWindsurfRule;
                case "FileService.toggleAgentsRule":
                    var toggledAgentsRule = ToggleSimpleRule(message, "localAgentsRulesToggles");
                    await BroadcastStateAsync();
                    return toggledAgentsRule;
                case "FileService.toggleWorkflow":
                    var toggledWorkflow = ToggleWorkflow(message);
                    await BroadcastStateAsync();
                    return toggledWorkflow;
                case "FileService.createRuleFile":
                    var createdRuleFile = await CreateRuleFileAsync(message);
                    await BroadcastStateAsync();
                    return createdRuleFile;
                case "FileService.deleteRuleFile":
                    var deletedRuleFile = await DeleteRuleFileAsync(message);
                    await BroadcastStateAsync();
                    return deletedRuleFile;
                case "FileService.refreshHooks":
                    return CreateHooksRefreshResponse();
                case "FileService.createHook":
                    return await CreateHookAsync(message);
                case "FileService.deleteHook":
                    return await DeleteHookAsync(message);
                case "FileService.toggleHook":
                    return ToggleHook(message);
                case "FileService.refreshSkills":
                    return CreateSkillsRefreshResponse();
                case "FileService.createSkillFile":
                    return await CreateSkillFileAsync(message);
                case "FileService.deleteSkillFile":
                    return await DeleteSkillFileAsync(message);
                case "FileService.toggleSkill":
                    return ToggleSkill(message);
                case "FileService.ifFileExistsRelativePath":
                    return IfFileExistsRelativePath(message.Value<string>("value"));
                case "FileService.getRelativePaths":
                    return GetRelativePathsResponse(message["uris"] as JArray);
                case "FileService.searchFiles":
                    return SearchFilesResponse(message);
                case "FileService.searchCommits":
                    return SearchCommitsResponse(message.Value<string>("value"));
                case "FileService.openMention":
                    await OpenMentionAsync(message.Value<string>("value"));
                    return new JObject();
                case "FileService.openDiskConversationHistory":
                    await OpenDiskConversationHistoryAsync(message.Value<string>("value"));
                    return new JObject();
                case "FileService.openFocusChainFile":
                    await OpenFocusChainFileAsync(message.Value<string>("value"));
                    return new JObject();
                case "FileService.selectFiles":
                    return await SelectFilesAsync(message.Value<bool?>("value") == true);
                case "FileService.openFile":
                case "FileService.openFileRelativePath":
                    await OpenFileAsync(message);
                    return new JObject();
                case "FileService.openImage":
                    OpenExternalUrl(message.Value<string>("value") ?? message.Value<string>("path"));
                    return new JObject();
                case "AccountService.getRedirectUrl":
                    return new JObject { ["value"] = "https://app.cline.bot" };
                case "AccountService.getUserOrganizations":
                    return CreateUnsupportedAccountOrganizationsResponse("Loading account organizations is not implemented in the Visual Studio port.");
                case "AccountService.getUserCredits":
                    return CreateEmptyCreditsResponse();
                case "AccountService.getOrganizationCredits":
                    return CreateEmptyCreditsResponse();
                case "AccountService.setUserOrganization":
                    return CreateUnsupportedAccountOperationResponse("Switching the active account organization is not implemented in the Visual Studio port.");
                case "AccountService.submitLimitIncreaseRequest":
                    return CreateUnsupportedAccountOperationResponse("Submitting spend-limit increase requests is not implemented in the Visual Studio port.");
                case "AccountService.accountLoginClicked":
                    return CreateUnsupportedAccountOperationResponse("Cline account sign-in is not implemented in the Visual Studio port.");
                case "AccountService.accountLogoutClicked":
                    return CreateUnsupportedAccountOperationResponse("Cline account sign-out is not implemented in the Visual Studio port.");
                case "AccountService.requestyAuthClicked":
                    return CreateUnsupportedAccountOperationResponse("Requesty OAuth is not implemented in the Visual Studio port.");
                case "AccountService.openrouterAuthClicked":
                    return CreateUnsupportedAccountOperationResponse("OpenRouter OAuth is not implemented in the Visual Studio port.");
                case "AccountService.hicapAuthClicked":
                    return CreateUnsupportedAccountOperationResponse("Hicap OAuth is not implemented in the Visual Studio port.");
                case "AccountService.openAiCodexSignIn":
                    return CreateUnsupportedAccountOperationResponse("OpenAI Codex OAuth is owned by the SDK sidecar for supported deployments. If this fallback appears, the sidecar handler did not answer.");
                case "AccountService.openAiCodexSignOut":
                    return CreateUnsupportedAccountOperationResponse("OpenAI Codex sign-out is owned by the SDK sidecar for supported deployments. If this fallback appears, the sidecar handler did not answer.");
                case "OcaAccountService.ocaAccountLoginClicked":
                    return CreateUnsupportedAccountOperationResponse("OCA account sign-in is owned by the SDK sidecar for supported deployments. If this fallback appears, the sidecar handler did not answer.");
                case "OcaAccountService.ocaAccountLogoutClicked":
                    return CreateUnsupportedAccountOperationResponse("OCA account sign-out is owned by the SDK sidecar for supported deployments. If this fallback appears, the sidecar handler did not answer.");
                case "SlashService.condense":
                    return await HandleSlashUtilityActionAsync();
                case "SlashService.reportBug":
                    return await HandleSlashUtilityActionAsync();
                default:
                    return new JObject();
            }
        }

        private async Task StartNewTaskAsync(JObject message)
        {
            _agentController.Stop();

            var text = message.Value<string>("text") ?? "";
            var images = message["images"] as JArray ?? new JArray();
            var files = message["files"] as JArray ?? new JArray();
            var agentTaskText = BuildTaskInputWithAttachments(text, images, files);

            _workspaceRoot = await _editorService.GetSolutionRootAsync() ?? _workspaceRoot;
            ClearCurrentTask(preserveHistory: true);

            _currentTaskId = Guid.NewGuid().ToString("N");
            _currentTaskText = text;
            _currentTaskCompleted = false;
            _state["currentTaskItem"] = CreateHistoryItem(_currentTaskId, text);

            AddMessage(new JObject
            {
                ["type"] = "say",
                ["say"] = "task",
                ["text"] = text,
                ["images"] = images,
                ["files"] = files
            });

            await BroadcastStateAsync();
            _ = _agentController.StartTaskAsync(agentTaskText, _workspaceRoot);
        }

        private async Task ResumeCurrentTaskAsync(JObject message)
        {
            _agentController.Stop();

            var text = message.Value<string>("text") ?? _currentTaskText;
            var hasText = !string.IsNullOrWhiteSpace(text);
            if (string.IsNullOrWhiteSpace(_currentTaskId) || _state["currentTaskItem"] is not JObject)
            {
                await StartNewTaskAsync(new JObject
                {
                    ["text"] = text,
                    ["images"] = message["images"] as JArray ?? new JArray(),
                    ["files"] = message["files"] as JArray ?? new JArray()
                });
                return;
            }

            _workspaceRoot = await _editorService.GetSolutionRootAsync() ?? _workspaceRoot;
            _currentTaskText = hasText ? text : _currentTaskText;
            _currentTaskCompleted = false;
            _pendingAskType = null;
            ResetRuntimeProgressState();
            UpdateCurrentTaskItem();
            SaveCurrentTaskSnapshot();
            var resumeHistory = _checkpointResumeHistorySeed ?? BuildResumeChatHistoryFromMessages(_state["clineMessages"] as JArray ?? new JArray());
            _checkpointResumeHistorySeed = null;
            var agentTaskText = BuildTaskInputWithAttachments(
                _currentTaskText,
                message["images"] as JArray,
                message["files"] as JArray);

            await BroadcastStateAsync();
            _ = _agentController.ResumeTaskAsync(agentTaskText, _workspaceRoot, resumeHistory);
        }

        private static string BuildTaskInputWithAttachments(string? text, JArray? images, JArray? files)
        {
            var baseText = text ?? string.Empty;
            var attachmentSummary = BuildAttachmentSummary(images, files);
            if (string.IsNullOrWhiteSpace(attachmentSummary))
            {
                return baseText;
            }

            if (string.IsNullOrWhiteSpace(baseText))
            {
                return attachmentSummary;
            }

            return baseText + "\n\n" + attachmentSummary;
        }

        private static string BuildUserResponseText(string? text, JArray? images, JArray? files)
        {
            var normalizedText = text ?? string.Empty;
            var attachmentSummary = BuildAttachmentSummary(images, files);
            if (string.IsNullOrWhiteSpace(attachmentSummary))
            {
                return normalizedText;
            }

            if (string.IsNullOrWhiteSpace(normalizedText))
            {
                return attachmentSummary;
            }

            return normalizedText + "\n\n" + attachmentSummary;
        }

        private static string BuildAttachmentSummary(JArray? images, JArray? files)
        {
            var imagePaths = (images ?? new JArray())
                .Values<string>()
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .Select(FormatAttachmentSummaryText)
                .ToList();
            var filePaths = (files ?? new JArray())
                .Values<string>()
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .Select(NormalizeResumeContextText)
                .ToList();

            if (imagePaths.Count == 0 && filePaths.Count == 0)
            {
                return string.Empty;
            }

            var builder = new StringBuilder();
            if (filePaths.Count > 0)
            {
                builder.AppendLine("Attached files:");
                foreach (var filePath in filePaths.Take(8))
                {
                    builder.Append("- ");
                    builder.AppendLine(filePath);
                }
            }

            if (imagePaths.Count > 0)
            {
                if (builder.Length > 0)
                {
                    builder.AppendLine();
                }

                builder.AppendLine("Attached images:");
                foreach (var imagePath in imagePaths.Take(8))
                {
                    builder.Append("- ");
                    builder.AppendLine(imagePath);
                }
            }

            return builder.ToString().Trim();
        }

        private static JObject? GetPendingAskMessageSnapshot(JArray messages, string? pendingAskType)
        {
            if (string.IsNullOrWhiteSpace(pendingAskType))
            {
                return null;
            }

            return messages
                .OfType<JObject>()
                .LastOrDefault(item => string.Equals(item.Value<string>("type"), "ask", StringComparison.Ordinal)
                    && string.Equals(item.Value<string>("ask"), pendingAskType, StringComparison.Ordinal))
                ?.DeepClone() as JObject;
        }

        private static JArray? GetConversationHistoryDeletedRangeSnapshot(JArray messages)
        {
            var deletedRange = messages
                .OfType<JObject>()
                .Select(item => item["conversationHistoryDeletedRange"] as JArray)
                .LastOrDefault(range => range != null && range.Count == 2);

            return deletedRange?.DeepClone() as JArray;
        }

        private long AddPendingAskMessage(JArray messages, string? pendingAskType, JObject? pendingAskMessage)
        {
            var effectiveAskType = pendingAskMessage?.Value<string>("ask") ?? pendingAskType;
            if (string.IsNullOrWhiteSpace(effectiveAskType))
            {
                return 0;
            }

            var lastMessage = messages.LastOrDefault() as JObject;
            if (string.Equals(lastMessage?.Value<string>("type"), "ask", StringComparison.Ordinal)
                && string.Equals(lastMessage?.Value<string>("ask"), effectiveAskType, StringComparison.Ordinal)
                && (pendingAskMessage == null
                    || (JToken.DeepEquals(lastMessage?["text"], pendingAskMessage["text"])
                        && JToken.DeepEquals(lastMessage?["options"], pendingAskMessage["options"]) 
                        && JToken.DeepEquals(lastMessage?["images"], pendingAskMessage["images"]) 
                        && JToken.DeepEquals(lastMessage?["files"], pendingAskMessage["files"])) ))
            {
                return lastMessage?.Value<long?>("ts") ?? 0;
            }

            var messageToAdd = pendingAskMessage?.DeepClone() as JObject ?? new JObject
            {
                ["type"] = "ask",
                ["ask"] = effectiveAskType,
                ["text"] = string.Empty
            };
            messageToAdd.Remove("ts");
            return AddMessage(messageToAdd);
        }

        private async Task HandleAskResponseAsync(JObject message)
        {
            var responseType = message.Value<string>("responseType") ?? "";
            var text = message.Value<string>("text") ?? "";
            var hasText = !string.IsNullOrWhiteSpace(text);
            var images = message["images"] as JArray ?? new JArray();
            var files = message["files"] as JArray ?? new JArray();
            var responseText = BuildUserResponseText(text, images, files);
            var pendingAskType = _pendingAskType;

            if (pendingAskType == "tool" || pendingAskType == "command")
            {
                var approved = responseType == "yesButtonClicked";
                _agentController.SetApproval(approved);
                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "user_feedback",
                    ["text"] = !string.IsNullOrWhiteSpace(responseText) ? responseText : (approved ? "Approved" : "Rejected"),
                    ["images"] = images,
                    ["files"] = files
                });
            }
            else if (pendingAskType == "resume_task" || pendingAskType == "resume_completed_task")
            {
                if (responseType == "yesButtonClicked")
                {
                    var resumedText = !string.IsNullOrWhiteSpace(responseText)
                        ? $"{_currentTaskText}\n\nAdditional context:\n{responseText}"
                        : _currentTaskText;

                    await ResumeCurrentTaskAsync(new JObject
                    {
                        ["text"] = resumedText,
                        ["images"] = images,
                        ["files"] = files
                    });
                    return;
                }

                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "user_feedback",
                    ["text"] = !string.IsNullOrWhiteSpace(responseText) ? responseText : "Resume declined",
                    ["images"] = images,
                    ["files"] = files
                });
            }
            else
            {
                _agentController.SetUserInput(responseText);
                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "user_feedback",
                    ["text"] = responseText,
                    ["images"] = images,
                    ["files"] = files
                });
            }

            _pendingAskType = null;
            await BroadcastStateAsync();
        }

        private async Task<JObject> HandleSlashUtilityActionAsync()
        {
            if (string.IsNullOrWhiteSpace(_pendingAskType))
            {
                return new JObject();
            }

            await HandleAskResponseAsync(new JObject
            {
                ["responseType"] = "yesButtonClicked",
                ["text"] = string.Empty,
                ["images"] = new JArray(),
                ["files"] = new JArray()
            });

            return new JObject();
        }

        private void ApplyStateSettings(JObject message)
        {
            var settings = _settingsService.Load();
            var shouldSaveSettings = false;

            if (message["preferredLanguage"] != null)
            {
                _state["preferredLanguage"] = message.Value<string>("preferredLanguage") ?? "English";
            }

            if (message["uiLanguage"] != null)
            {
                var uiLanguage = message.Value<string>("uiLanguage");
                _state["uiLanguage"] = string.Equals(uiLanguage, "en", StringComparison.OrdinalIgnoreCase) ? "en" : "ko";
            }

            if (message["mode"] != null)
            {
                _state["mode"] = message.Value<string>("mode") ?? "act";
            }

            if (message["telemetrySetting"] != null)
            {
                _state["telemetrySetting"] = message.Value<string>("telemetrySetting") ?? "unset";
            }

            if (message["showFeatureTips"] != null)
            {
                _state["showFeatureTips"] = message.Value<bool?>("showFeatureTips") == true;
            }

            if (message["enableCheckpointsSetting"] != null)
            {
                var enabled = message.Value<bool?>("enableCheckpointsSetting") == true;
                _state["enableCheckpointsSetting"] = enabled;
                settings.EnableCheckpointsSetting = enabled;
                shouldSaveSettings = true;

                if (enabled)
                {
                    _state["checkpointManagerErrorMessage"] = null;
                }
                else
                {
                    _state["checkpointManagerErrorMessage"] = "Checkpoints are disabled in settings.";
                }
            }

            if (message["autoApprovalSettings"] is JObject autoApproval)
            {
                ApplyAutoApprovalSettings(autoApproval);
            }

            if (shouldSaveSettings)
            {
                _settingsService.Save(settings);
            }
        }

        private void ApplyAutoApprovalSettings(JObject autoApproval)
        {
            _state["autoApprovalSettings"] = autoApproval.DeepClone();
            var settings = _settingsService.Load();
            settings.AutoApprovalSettings = autoApproval.ToObject<AutoApprovalPreferences>() ?? new AutoApprovalPreferences();
            settings.AutoApprove = settings.AutoApprovalSettings.Enabled;
            _settingsService.Save(settings);
        }

        private JObject UpdateTerminalConnectionTimeout(JObject message)
        {
            var timeoutMs = Math.Max(1000, message.Value<int?>("timeoutMs") ?? 4000);
            _state["shellIntegrationTimeout"] = timeoutMs;
            return new JObject
            {
                ["timeoutMs"] = timeoutMs
            };
        }

        private void ApplyApiConfiguration(JObject message)
        {
            var settings = _settingsService.Load();

            var provider = message.Value<string>("actModeApiProvider") ?? message.Value<string>("apiProvider");
            if (!string.IsNullOrWhiteSpace(provider))
            {
                ((JObject)_state["apiConfiguration"])["actModeApiProvider"] = provider;
                ((JObject)_state["apiConfiguration"])["planModeApiProvider"] = provider;
            }

            var modelId = message.Value<string>("actModeOpenAiModelId")
                ?? message.Value<string>("planModeOpenAiModelId")
                ?? message.Value<string>("openAiModelId");
            if (!string.IsNullOrWhiteSpace(modelId))
            {
                settings.ModelName = modelId;
            }

            var baseUrl = message.Value<string>("actModeOpenAiBaseUrl")
                ?? message.Value<string>("planModeOpenAiBaseUrl")
                ?? message.Value<string>("openAiBaseUrl");
            if (!string.IsNullOrWhiteSpace(baseUrl))
            {
                settings.LlmBaseUrl = baseUrl;
            }

            var apiKey = message.Value<string>("actModeOpenAiApiKey")
                ?? message.Value<string>("planModeOpenAiApiKey")
                ?? message.Value<string>("openAiApiKey");
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                settings.ApiKey = apiKey;
            }

            _settingsService.Save(settings);
            _state["apiConfiguration"] = CreateApiConfiguration(settings);
        }

        private async Task<JObject> SelectFilesAsync(bool allowImages)
        {
            var dialog = new OpenFileDialog
            {
                Multiselect = true,
                CheckFileExists = true,
                Title = "Select files for Cline"
            };

            var imagePaths = new JArray();
            var filePaths = new JArray();

            if (dialog.ShowDialog() == true)
            {
                foreach (var fileName in dialog.FileNames)
                {
                    if (allowImages && IsImagePath(fileName))
                    {
                        imagePaths.Add(TryCreateImageDataUri(fileName) ?? fileName);
                    }
                    else
                    {
                        filePaths.Add(fileName);
                    }
                }
            }

            return new JObject
            {
                ["values1"] = imagePaths,
                ["values2"] = filePaths
            };
        }

        private JObject GetDetectedChromePathResponse()
        {
            var settings = _settingsService.Load();
            var configuredPath = _state["browserSettings"]?["chromeExecutablePath"]?.ToString();
            var detectedPath = ResolveChromeExecutablePath(configuredPath);

            return new JObject
            {
                ["path"] = detectedPath ?? string.Empty,
                ["isBundled"] = false
            };
        }

        private async Task<JObject> GetBrowserConnectionInfoAsync()
        {
            var browserSettings = _state["browserSettings"] as JObject;
            var remoteBrowserEnabled = browserSettings?.Value<bool?>("remoteBrowserEnabled") == true;
            var host = browserSettings?.Value<string>("remoteBrowserHost") ?? string.Empty;

            bool isConnected;
            if (remoteBrowserEnabled)
            {
                isConnected = await CanReachBrowserHostAsync(host);
            }
            else
            {
                isConnected = !string.IsNullOrWhiteSpace(ResolveChromeExecutablePath(browserSettings?.Value<string>("chromeExecutablePath")));
            }

            return new JObject
            {
                ["isConnected"] = isConnected,
                ["isRemote"] = remoteBrowserEnabled,
                ["host"] = remoteBrowserEnabled ? host : string.Empty
            };
        }

        private async Task<JObject> TestBrowserConnectionAsync(string? host)
        {
            var success = await CanReachBrowserHostAsync(host);
            return new JObject
            {
                ["success"] = success,
                ["message"] = success ? "Browser connection successful." : "Unable to reach the configured browser host."
            };
        }

        private async Task<JObject> DiscoverBrowserAsync()
        {
            var browserSettings = _state["browserSettings"] as JObject;
            var remoteBrowserEnabled = browserSettings?.Value<bool?>("remoteBrowserEnabled") == true;

            if (remoteBrowserEnabled)
            {
                return await TestBrowserConnectionAsync(browserSettings?.Value<string>("remoteBrowserHost"));
            }

            var path = ResolveChromeExecutablePath(browserSettings?.Value<string>("chromeExecutablePath"));
            return new JObject
            {
                ["success"] = !string.IsNullOrWhiteSpace(path),
                ["message"] = !string.IsNullOrWhiteSpace(path)
                    ? $"Detected browser at {path}"
                    : "No local Chrome or Edge executable could be found.",
                ["path"] = path ?? string.Empty
            };
        }

        private JObject RelaunchChromeDebugMode()
        {
            var browserSettings = _state["browserSettings"] as JObject;
            var host = browserSettings?.Value<string>("remoteBrowserHost") ?? "http://localhost:9222";

            return new JObject
            {
                ["value"] =
                    "Automatic Chrome relaunch is not implemented in the Visual Studio host yet. " +
                    $"Launch Chrome manually with remote debugging enabled, for example: chrome.exe --remote-debugging-port=9222, then reconnect to {host}."
            };
        }

        private static JObject CreateUnsupportedCheckpointResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["message"] = message,
                ["value"] = message
            };
        }

        private static JObject CreateCheckpointSuccessResponse(string message)
        {
            return new JObject
            {
                ["success"] = true,
                ["message"] = message,
                ["value"] = message
            };
        }

        private async Task<JObject> HandleCheckpointRestoreAsync(JObject message)
        {
            if (!AreCheckpointsEnabled())
            {
                return CreateUnsupportedCheckpointResponse("Checkpoints are disabled in settings.");
            }

            var messageTs = message.Value<long?>("number") ?? message.Value<long?>("value");
            var restoreType = message.Value<string>("restoreType") ?? "taskAndWorkspace";
            var offset = message.Value<int?>("offset") ?? 0;

            if (!messageTs.HasValue)
            {
                return CreateUnsupportedCheckpointResponse("Checkpoint restore requires a target message timestamp.");
            }

            var clineMessages = ((JArray)_state["clineMessages"]).OfType<JObject>().ToList();
            var messageIndex = clineMessages.FindIndex(item => item.Value<long?>("ts") == messageTs.Value);
            if (messageIndex < 0)
            {
                return CreateUnsupportedCheckpointResponse("Checkpoint restore target was not found in the current task.");
            }

            messageIndex = Math.Max(0, messageIndex - offset);
            var targetMessage = clineMessages[messageIndex];
            var targetHash = targetMessage.Value<string>("lastCheckpointHash");
            var checkpointMetadataSource = targetMessage;
            if (string.IsNullOrWhiteSpace(targetHash))
            {
                checkpointMetadataSource = clineMessages
                    .Take(messageIndex)
                    .LastOrDefault(item => !string.IsNullOrWhiteSpace(item.Value<string>("lastCheckpointHash")));
                targetHash = checkpointMetadataSource?.Value<string>("lastCheckpointHash");
            }

            if ((restoreType == "workspace" || restoreType == "taskAndWorkspace") && string.IsNullOrWhiteSpace(targetHash))
            {
                return CreateUnsupportedCheckpointResponse("No checkpoint hash is available for this restore target.");
            }

            _agentController.Stop();
            ResetRuntimeProgressState();

            if ((restoreType == "workspace" || restoreType == "taskAndWorkspace") && !string.IsNullOrWhiteSpace(targetHash))
            {
                var session = await EnsureCheckpointSessionAsync();
                if (session == null)
                {
                    return CreateUnsupportedCheckpointResponse("Checkpoint workspace restore is unavailable because the workspace is not backed by a usable git repository.");
                }

                try
                {
                    RunCheckpointGitCommand(session, $"reset --hard {EscapeGitArgument(targetHash)}");
                }
                catch (Exception ex)
                {
                    return CreateUnsupportedCheckpointResponse("Failed to restore checkpoint workspace: " + ex.Message);
                }

                MarkCheckpointCheckoutState(targetHash);
            }

            if (restoreType == "task" || restoreType == "taskAndWorkspace")
            {
                var restoredMessages = new JArray(clineMessages.Take(messageIndex + 1).Select(item => item.DeepClone()));
                _state["clineMessages"] = restoredMessages;
                if (checkpointMetadataSource?["checkpointTaskItem"] is JObject checkpointTaskItem)
                {
                    _state["currentTaskItem"] = checkpointTaskItem.DeepClone();
                }
                _currentTaskText = checkpointMetadataSource?.Value<string>("checkpointTaskText")
                    ?? GetTaskTextFromMessages(restoredMessages)
                    ?? _currentTaskText;
                _currentTaskCompleted = checkpointMetadataSource?.Value<bool?>("checkpointIsCompleted")
                    ?? IsTaskCompletedFromMessages(restoredMessages);
                _pendingAskType = checkpointMetadataSource?.Value<string>("checkpointPendingAskType")
                    ?? (_currentTaskCompleted ? "resume_completed_task" : "resume_task");
                var pendingAskMessage = checkpointMetadataSource?["checkpointPendingAskMessage"] as JObject;
                _checkpointResumeHistorySeed = checkpointMetadataSource?["checkpointApiHistory"] is JArray checkpointApiHistory
                    ? checkpointApiHistory.ToObject<List<ChatMessage>>()
                    : (checkpointMetadataSource?["checkpointResumeHistory"] is JArray checkpointResumeHistory
                        ? checkpointResumeHistory.ToObject<List<ChatMessage>>()
                        : null);
                if (checkpointMetadataSource?["checkpointConversationHistoryDeletedRange"] is JArray checkpointDeletedRange && checkpointDeletedRange.Count == 2)
                {
                    if (_state["currentTaskItem"] is JObject taskItem)
                    {
                        taskItem["conversationHistoryDeletedRange"] = checkpointDeletedRange.DeepClone();
                    }
                }

                AddPendingAskMessage(restoredMessages, _pendingAskType, pendingAskMessage);

                UpdateCurrentTaskItem();
                if (_state["currentTaskItem"] is JObject currentTaskItem)
                {
                    currentTaskItem["modelId"] = checkpointMetadataSource?.Value<string>("checkpointModelId")
                        ?? currentTaskItem.Value<string>("modelId")
                        ?? _settingsService.Load().ModelName;
                    currentTaskItem["cwdOnTaskInitialization"] = checkpointMetadataSource?.Value<string>("checkpointWorkspaceRoot")
                        ?? currentTaskItem.Value<string>("cwdOnTaskInitialization")
                        ?? _workspaceRoot;
                }
            }

            SaveCurrentTaskSnapshot();
            await BroadcastStateAsync();
            await BroadcastRelinquishControlAsync();
            return CreateCheckpointSuccessResponse("Checkpoint restored.");
        }

        private async Task<JObject> HandleCheckpointDiffAsync(JObject message)
        {
            if (!AreCheckpointsEnabled())
            {
                return CreateUnsupportedCheckpointResponse("Checkpoints are disabled in settings.");
            }

            var messageTs = message.Value<long?>("value") ?? message.Value<long?>("number");
            if (!messageTs.HasValue)
            {
                return CreateUnsupportedCheckpointResponse("Checkpoint diff requires a target message timestamp.");
            }

            var diffText = await BuildCheckpointDiffAsync(messageTs.Value, compareToCurrentWorkspace: true);
            if (diffText == null)
            {
                return CreateUnsupportedCheckpointResponse("Checkpoint diff is unavailable because no checkpoint hash exists for the selected message.");
            }

            if (string.IsNullOrWhiteSpace(diffText))
            {
                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "info",
                    ["text"] = "No workspace changes were found for this checkpoint."
                });
                await BroadcastStateAsync();
                await BroadcastRelinquishControlAsync();
                return CreateCheckpointSuccessResponse("No changes found.");
            }

            var path = WriteWorkspaceTempFile(_currentTaskId ?? "checkpoint", "checkpoint-diff", ".diff", diffText);
            await _editorService.OpenFileAsync(path, null);
            await BroadcastRelinquishControlAsync();
            return CreateCheckpointSuccessResponse("Checkpoint diff opened.");
        }

        private JObject CreateWorktreeListResponse()
        {
            var workspaceRoot = _workspaceRoot;
            var gitRoot = !string.IsNullOrWhiteSpace(workspaceRoot) ? FindGitRoot(workspaceRoot) : null;
            var effectiveRoot = gitRoot ?? workspaceRoot;

            return new JObject
            {
                ["worktrees"] = string.IsNullOrWhiteSpace(effectiveRoot)
                    ? new JArray()
                    : new JArray(CreateWorktreeEntry(effectiveRoot, isBare: false)),
                ["isGitRepo"] = !string.IsNullOrWhiteSpace(gitRoot),
                ["isMultiRoot"] = false,
                ["isSubfolder"] = !string.IsNullOrWhiteSpace(gitRoot) && !string.Equals(gitRoot, workspaceRoot, StringComparison.OrdinalIgnoreCase),
                ["gitRootPath"] = gitRoot ?? string.Empty,
                ["error"] = string.Empty
            };
        }

        private JObject CreateWorktreeDefaultsResponse()
        {
            var workspaceRoot = _workspaceRoot;
            var rootName = string.IsNullOrWhiteSpace(workspaceRoot) ? "worktree" : Path.GetFileName(workspaceRoot.TrimEnd(Path.DirectorySeparatorChar));
            var parent = string.IsNullOrWhiteSpace(workspaceRoot) ? string.Empty : Directory.GetParent(workspaceRoot)?.FullName ?? workspaceRoot;
            var suggestedBranch = $"feature/{rootName}-task";
            var suggestedPath = string.IsNullOrWhiteSpace(parent)
                ? string.Empty
                : Path.Combine(parent, rootName + "-worktree");

            return new JObject
            {
                ["suggestedBranch"] = suggestedBranch,
                ["suggestedPath"] = suggestedPath
            };
        }

        private JObject GetWorktreeIncludeStatusResponse()
        {
            var gitRoot = FindGitRoot(_workspaceRoot);
            var root = gitRoot ?? _workspaceRoot;
            var worktreeIncludePath = string.IsNullOrWhiteSpace(root) ? null : Path.Combine(root, ".worktreeinclude");
            var gitignorePath = string.IsNullOrWhiteSpace(root) ? null : Path.Combine(root, ".gitignore");

            return new JObject
            {
                ["exists"] = !string.IsNullOrWhiteSpace(worktreeIncludePath) && File.Exists(worktreeIncludePath),
                ["hasGitignore"] = !string.IsNullOrWhiteSpace(gitignorePath) && File.Exists(gitignorePath),
                ["gitignoreContent"] = !string.IsNullOrWhiteSpace(gitignorePath) && File.Exists(gitignorePath)
                    ? File.ReadAllText(gitignorePath)
                    : string.Empty
            };
        }

        private JObject CreateWorktreeInclude(JObject message)
        {
            var gitRoot = FindGitRoot(_workspaceRoot);
            var root = gitRoot ?? _workspaceRoot;
            if (string.IsNullOrWhiteSpace(root))
            {
                return CreateUnsupportedWorktreeResponse("No workspace root is available to create .worktreeinclude.");
            }

            var content = message.Value<string>("content") ?? string.Empty;
            var targetPath = Path.Combine(root, ".worktreeinclude");
            File.WriteAllText(targetPath, content);

            return new JObject
            {
                ["success"] = true,
                ["message"] = ".worktreeinclude created successfully.",
                ["path"] = targetPath
            };
        }

        private static JObject CreateUnsupportedWorktreeResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["message"] = message
            };
        }

        private static JObject CreateUnsupportedMergeWorktreeResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["message"] = message,
                ["hasConflicts"] = false,
                ["conflictingFiles"] = new JArray(),
                ["sourceBranch"] = string.Empty,
                ["targetBranch"] = string.Empty
            };
        }

        private static JObject CreateUnsupportedStateOperationResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["error"] = message
            };
        }

        private static JObject CreateUnsupportedTaskOperationResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["message"] = message,
                ["value"] = message
            };
        }

        private static JObject CreateUnsupportedAccountOperationResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["message"] = message,
                ["error"] = message,
                ["value"] = message
            };
        }

        private static JObject CreateUnsupportedAccountOrganizationsResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["message"] = message,
                ["error"] = message,
                ["organizations"] = new JArray()
            };
        }

        private static JObject CreateUnauthenticatedAuthStateResponse()
        {
            return new JObject();
        }

        private static JObject CreateUnauthenticatedOcaAuthStateResponse()
        {
            return new JObject();
        }

        private static JObject CreateWorktreeEntry(string path, bool isBare)
        {
            return new JObject
            {
                ["path"] = path,
                ["branch"] = "main",
                ["commit"] = string.Empty,
                ["locked"] = false,
                ["prunable"] = false,
                ["isBare"] = isBare
            };
        }

        private static string? FindGitRoot(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return null;
            }

            var current = new DirectoryInfo(path);
            while (current != null)
            {
                if (Directory.Exists(Path.Combine(current.FullName, ".git")) || File.Exists(Path.Combine(current.FullName, ".git")))
                {
                    return current.FullName;
                }

                current = current.Parent;
            }

            return null;
        }

        private static string? ResolveChromeExecutablePath(string? configuredPath)
        {
            if (!string.IsNullOrWhiteSpace(configuredPath) && File.Exists(configuredPath))
            {
                return configuredPath;
            }

            var candidates = new List<string>();

            void AddIfPresent(string? value)
            {
                if (!string.IsNullOrWhiteSpace(value))
                {
                    candidates.Add(value);
                }
            }

            AddIfPresent(ReadRegistryBrowserPath(RegistryHive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"));
            AddIfPresent(ReadRegistryBrowserPath(RegistryHive.CurrentUser, @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"));
            AddIfPresent(ReadRegistryBrowserPath(RegistryHive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"));
            AddIfPresent(ReadRegistryBrowserPath(RegistryHive.CurrentUser, @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"));

            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            AddIfPresent(Path.Combine(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
            AddIfPresent(Path.Combine(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));
            AddIfPresent(Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
            AddIfPresent(Path.Combine(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"));
            AddIfPresent(Path.Combine(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"));

            return candidates.FirstOrDefault(File.Exists);
        }

        private static string? ReadRegistryBrowserPath(RegistryHive hive, string subKey)
        {
            try
            {
                using var baseKey = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64);
                using var appKey = baseKey.OpenSubKey(subKey);
                return appKey?.GetValue(string.Empty) as string;
            }
            catch
            {
                return null;
            }
        }

        private static async Task<bool> CanReachBrowserHostAsync(string? host)
        {
            if (string.IsNullOrWhiteSpace(host))
            {
                return false;
            }

            var normalized = host.TrimEnd('/');
            if (!normalized.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !normalized.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                normalized = "http://" + normalized;
            }

            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
                using var response = await http.GetAsync(normalized + "/json/version");
                return response.IsSuccessStatusCode;
            }
            catch
            {
                return false;
            }
        }

        private JObject CreateCurrentModelCatalog()
        {
            var settings = _settingsService.Load();
            return new JObject
            {
                ["models"] = new JObject
                {
                    [settings.ModelName] = new JObject
                    {
                        ["maxTokens"] = settings.MaxTokens,
                        ["contextWindow"] = settings.MaxTokens,
                        ["supportsImages"] = false,
                        ["supportsPromptCache"] = false,
                        ["supportsReasoning"] = false,
                        ["inputPrice"] = 0,
                        ["outputPrice"] = 0,
                        ["cacheWritesPrice"] = 0,
                        ["cacheReadsPrice"] = 0,
                        ["description"] = "Configured local model",
                        ["supportsGlobalEndpoint"] = false,
                        ["tiers"] = new JArray()
                    }
                }
            };
        }

        private static JObject CreateEmptyMcpServersResponse()
        {
            return new JObject
            {
                ["mcpServers"] = new JArray()
            };
        }

        private static JObject CreateUnsupportedMcpServersResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["message"] = message,
                ["error"] = message,
                ["mcpServers"] = new JArray()
            };
        }

        private static JObject CreateEmptyMcpMarketplaceCatalog()
        {
            return new JObject
            {
                ["items"] = new JArray()
            };
        }

        private static JObject CreateUnsupportedMcpDownloadResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["message"] = message,
                ["error"] = message
            };
        }

        private static JObject CreateUnsupportedMcpOperationResponse(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["message"] = message,
                ["error"] = message,
                ["value"] = message
            };
        }

        private async Task OpenFileAsync(JObject message)
        {
            var path = message.Value<string>("value") ?? message.Value<string>("path") ?? "";
            if (string.IsNullOrWhiteSpace(path))
            {
                return;
            }

            if (!Path.IsPathRooted(path) && !string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                path = Path.Combine(_workspaceRoot, path);
            }

            await _editorService.OpenFileAsync(path, message.Value<int?>("line"));
        }

        private JObject IfFileExistsRelativePath(string? relativePath)
        {
            var fullPath = ResolveWorkspaceRelativePath(relativePath);
            return new JObject
            {
                ["value"] = !string.IsNullOrWhiteSpace(fullPath) && File.Exists(fullPath)
            };
        }

        private JObject GetRelativePathsResponse(JArray? uris)
        {
            var paths = new JArray();
            if (uris == null)
            {
                return new JObject { ["paths"] = paths };
            }

            foreach (var token in uris)
            {
                var localPath = TryGetLocalPathFromUri(token?.ToString());
                if (string.IsNullOrWhiteSpace(localPath))
                {
                    continue;
                }

                var relative = MakeWorkspaceRelativePath(localPath);
                paths.Add(relative ?? localPath);
            }

            return new JObject { ["paths"] = paths };
        }

        private JObject SearchFilesResponse(JObject message)
        {
            var query = (message.Value<string>("query") ?? string.Empty).Replace('\\', '/').Trim();
            var selectedType = (message.Value<string>("selectedType") ?? string.Empty).ToLowerInvariant();
            var results = new JArray();

            if (string.IsNullOrWhiteSpace(_workspaceRoot) || !Directory.Exists(_workspaceRoot))
            {
                return new JObject { ["results"] = results };
            }

            var includeFiles = selectedType != "folder";
            var includeFolders = selectedType != "file";
            var candidates = new List<(string Path, string Type)>();

            try
            {
                if (includeFiles)
                {
                    candidates.AddRange(Directory.EnumerateFiles(_workspaceRoot, "*", SearchOption.AllDirectories)
                        .Where(path => !IsIgnoredSearchPath(path))
                        .Select(path => (path, "file")));
                }

                if (includeFolders)
                {
                    candidates.AddRange(Directory.EnumerateDirectories(_workspaceRoot, "*", SearchOption.AllDirectories)
                        .Where(path => !IsIgnoredSearchPath(path))
                        .Select(path => (path, "folder")));
                }
            }
            catch
            {
                return new JObject { ["results"] = results };
            }

            foreach (var item in candidates
                .Select(item => new
                {
                    item.Type,
                    RelativePath = (MakeWorkspaceRelativePath(item.Path) ?? item.Path).Replace('\\', '/'),
                    Label = Path.GetFileName(item.Path)
                })
                .Where(item => string.IsNullOrWhiteSpace(query)
                    || item.RelativePath.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0
                    || item.Label.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderBy(item => item.RelativePath.Length)
                .ThenBy(item => item.RelativePath, StringComparer.OrdinalIgnoreCase)
                .Take(100))
            {
                results.Add(new JObject
                {
                    ["path"] = item.RelativePath,
                    ["type"] = item.Type,
                    ["label"] = item.Label
                });
            }

            return new JObject { ["results"] = results };
        }

        private JObject SearchCommitsResponse(string? query)
        {
            var commits = new JArray();
            var gitRoot = FindGitRoot(_workspaceRoot);
            if (string.IsNullOrWhiteSpace(gitRoot))
            {
                return new JObject { ["commits"] = commits };
            }

            try
            {
                var escapedQuery = (query ?? string.Empty).Replace("\"", "\\\"");
                var arguments = string.IsNullOrWhiteSpace(escapedQuery)
                    ? "log --max-count=30 --date=short --pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad"
                    : $"log --max-count=30 --date=short --pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad --all --grep=\"{escapedQuery}\"";
                var output = RunProcessCapture("git", arguments, gitRoot);

                foreach (var line in output.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var parts = line.Split('\x1f');
                    if (parts.Length < 5)
                    {
                        continue;
                    }

                    commits.Add(new JObject
                    {
                        ["hash"] = parts[0],
                        ["shortHash"] = parts[1],
                        ["subject"] = parts[2],
                        ["author"] = parts[3],
                        ["date"] = parts[4]
                    });
                }
            }
            catch
            {
                // Return empty results when git is unavailable.
            }

            return new JObject { ["commits"] = commits };
        }

        private async Task OpenMentionAsync(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return;
            }

            var mention = value.Trim().Trim('"');
            if (string.Equals(mention, "problems", StringComparison.OrdinalIgnoreCase)
                || string.Equals(mention, "terminal", StringComparison.OrdinalIgnoreCase)
                || string.Equals(mention, "git-changes", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            var normalized = mention.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
            var fullPath = ResolveWorkspaceRelativePath(normalized) ?? mention;
            if (File.Exists(fullPath))
            {
                await _editorService.OpenFileAsync(fullPath, null);
            }
        }

        private async Task OpenDiskConversationHistoryAsync(string? taskId)
        {
            if (string.IsNullOrWhiteSpace(taskId) || !_taskSnapshots.TryGetValue(taskId, out var snapshot))
            {
                return;
            }

            var export = new JObject
            {
                ["task"] = snapshot.TaskItem.DeepClone(),
                ["messages"] = snapshot.Messages.DeepClone(),
                ["isCompleted"] = snapshot.IsCompleted
            };

            var path = WriteWorkspaceTempFile(taskId, "conversation-history", ".json", export.ToString(Formatting.Indented));
            await _editorService.OpenFileAsync(path, null);
        }

        private async Task OpenFocusChainFileAsync(string? taskId)
        {
            if (string.IsNullOrWhiteSpace(taskId) || !_taskSnapshots.TryGetValue(taskId, out var snapshot))
            {
                return;
            }

            var focusText = snapshot.Messages
                .OfType<JObject>()
                .Select(message => message.Value<string>("text"))
                .Where(text => !string.IsNullOrWhiteSpace(text) && (text.Contains("- [") || text.Contains("TODO") || text.Contains("Todo")))
                .LastOrDefault() ?? "No focus chain content is available for this task snapshot yet.";

            var path = WriteWorkspaceTempFile(taskId, "focus-chain", ".md", focusText);
            await _editorService.OpenFileAsync(path, null);
        }

        private string? ResolveWorkspaceRelativePath(string? relativePath)
        {
            if (string.IsNullOrWhiteSpace(relativePath))
            {
                return null;
            }

            if (Path.IsPathRooted(relativePath))
            {
                return relativePath;
            }

            if (string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                return null;
            }

            var trimmed = relativePath.TrimStart('/', '\\').Replace('/', Path.DirectorySeparatorChar);
            return Path.Combine(_workspaceRoot, trimmed);
        }

        private string? MakeWorkspaceRelativePath(string? fullPath)
        {
            if (string.IsNullOrWhiteSpace(fullPath) || string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                return null;
            }

            try
            {
                var relative = GetRelativePath(_workspaceRoot, fullPath);
                return relative.StartsWith("..", StringComparison.Ordinal) ? fullPath : relative.Replace('\\', '/');
            }
            catch
            {
                return fullPath;
            }
        }

        private static string GetRelativePath(string basePath, string fullPath)
        {
            var normalizedBase = Path.GetFullPath(basePath)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            var normalizedFullPath = Path.GetFullPath(fullPath);

            if (!normalizedFullPath.StartsWith(normalizedBase, StringComparison.OrdinalIgnoreCase))
            {
                return fullPath;
            }

            return normalizedFullPath.Substring(normalizedBase.Length);
        }

        private static string? TryGetLocalPathFromUri(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return null;
            }

            if (Uri.TryCreate(raw, UriKind.Absolute, out var uri) && uri.IsFile)
            {
                return uri.LocalPath;
            }

            if (raw.StartsWith("vscode-file:/", StringComparison.OrdinalIgnoreCase))
            {
                var normalized = raw.Substring("vscode-file:/".Length).TrimStart('/');
                return Uri.UnescapeDataString(normalized.Replace('/', '\\'));
            }

            return null;
        }

        private static bool IsIgnoredSearchPath(string path)
        {
            var normalized = path.Replace('\\', '/');
            return normalized.Contains("/.git/")
                || normalized.Contains("/node_modules/")
                || normalized.Contains("/bin/")
                || normalized.Contains("/obj/");
        }

        private static string RunProcessCapture(string fileName, string arguments, string workingDirectory)
        {
            using (var process = new Process())
            {
                process.StartInfo = new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    WorkingDirectory = workingDirectory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                process.Start();
                var output = process.StandardOutput.ReadToEnd();
                process.WaitForExit(5000);
                return output;
            }
        }

        private static string RunCheckpointGitCommand(CheckpointSession session, string arguments)
        {
            var gitDirectory = Path.Combine(session.ShadowGitRoot, ".git");
            var fullArguments = $"--git-dir=\"{gitDirectory}\" --work-tree=\"{session.WorkspaceRoot}\" {arguments}";
            return RunProcessCapture("git", fullArguments, session.ShadowGitRoot);
        }

        private static string EscapeGitArgument(string value)
        {
            return value.Replace("\"", "\\\"");
        }

        private static string ComputeStableHash(string value)
        {
            using (var sha256 = SHA256.Create())
            {
                var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(value));
                return string.Concat(bytes.Select(b => b.ToString("x2")));
            }
        }

        private string WriteWorkspaceTempFile(string taskId, string suffix, string extension, string content)
        {
            var directory = Path.Combine(Path.GetTempPath(), "VsClineAgent", "exports");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, taskId + "-" + suffix + extension);
            File.WriteAllText(path, content);
            return path;
        }

        private string GetApplicationDataDirectory()
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "VsClineAgent");
            Directory.CreateDirectory(directory);
            return directory;
        }

        private string GetToggleStorePath()
        {
            return Path.Combine(GetApplicationDataDirectory(), "rule-toggles.json");
        }

        private JObject LoadToggleStore()
        {
            var path = GetToggleStorePath();
            if (!File.Exists(path))
            {
                return new JObject();
            }

            try
            {
                return JObject.Parse(File.ReadAllText(path));
            }
            catch
            {
                return new JObject();
            }
        }

        private void SaveToggleStore(JObject store)
        {
            File.WriteAllText(GetToggleStorePath(), store.ToString(Formatting.Indented));
        }

        private static JObject GetOrCreateObject(JObject parent, string propertyName)
        {
            var existing = parent[propertyName] as JObject;
            if (existing != null)
            {
                return existing;
            }

            var created = new JObject();
            parent[propertyName] = created;
            return created;
        }

        private JObject GetOrCreateWorkspaceToggleStore(JObject store)
        {
            var workspaces = GetOrCreateObject(store, "workspaces");
            var workspaceKey = string.IsNullOrWhiteSpace(_workspaceRoot) ? "__default__" : _workspaceRoot;
            return GetOrCreateObject(workspaces, workspaceKey);
        }

        private static bool IsEnabledByDefault(JObject toggles, string key)
        {
            return toggles.Value<bool?>(key) != false;
        }

        private static JObject BuildToggleMap(IEnumerable<string> paths, JObject toggles)
        {
            var result = new JObject();
            foreach (var path in paths.OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
            {
                result[path] = IsEnabledByDefault(toggles, path);
            }

            return result;
        }

        private static void RemoveMissingToggleKeys(JObject toggles, IEnumerable<string> validKeys)
        {
            var valid = new HashSet<string>(validKeys, StringComparer.OrdinalIgnoreCase);
            var staleKeys = toggles.Properties()
                .Where(property => !valid.Contains(property.Name))
                .Select(property => property.Name)
                .ToList();

            foreach (var key in staleKeys)
            {
                toggles.Remove(key);
            }
        }

        private static bool IsSupportedRuleFile(string path, bool allowExtensionless)
        {
            var extension = Path.GetExtension(path);
            if (string.IsNullOrEmpty(extension))
            {
                return allowExtensionless;
            }

            return string.Equals(extension, ".md", StringComparison.OrdinalIgnoreCase)
                || string.Equals(extension, ".txt", StringComparison.OrdinalIgnoreCase);
        }

        private static IEnumerable<string> SafeEnumerateFiles(string directory, string searchPattern, SearchOption searchOption)
        {
            if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
            {
                return Enumerable.Empty<string>();
            }

            try
            {
                return Directory.EnumerateFiles(directory, searchPattern, searchOption).ToArray();
            }
            catch
            {
                return Enumerable.Empty<string>();
            }
        }

        private static IEnumerable<string> SafeEnumerateDirectories(string directory)
        {
            if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
            {
                return Enumerable.Empty<string>();
            }

            try
            {
                return Directory.EnumerateDirectories(directory).ToArray();
            }
            catch
            {
                return Enumerable.Empty<string>();
            }
        }

        private string GetGlobalRulesDirectory()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Cline", "Rules");
        }

        private string GetGlobalWorkflowsDirectory()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Cline", "Workflows");
        }

        private string GetGlobalHooksDirectory()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Cline", "Hooks");
        }

        private string GetUserProfileDirectory()
        {
            var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrWhiteSpace(userProfile))
            {
                return userProfile;
            }

            return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        }

        private string GetGlobalSkillsDirectory()
        {
            return Path.Combine(GetUserProfileDirectory(), ".cline", "skills");
        }

        private string GetWorkspaceRulesDirectory()
        {
            return string.IsNullOrWhiteSpace(_workspaceRoot)
                ? string.Empty
                : Path.Combine(_workspaceRoot, ".clinerules");
        }

        private string GetWorkspaceWorkflowsDirectory()
        {
            return string.IsNullOrWhiteSpace(_workspaceRoot)
                ? string.Empty
                : Path.Combine(_workspaceRoot, ".clinerules", "workflows");
        }

        private string GetWorkspaceHooksDirectory()
        {
            return string.IsNullOrWhiteSpace(_workspaceRoot)
                ? string.Empty
                : Path.Combine(_workspaceRoot, ".clinerules", "hooks");
        }

        private string GetWorkspaceSkillsDirectory()
        {
            return string.IsNullOrWhiteSpace(_workspaceRoot)
                ? string.Empty
                : Path.Combine(_workspaceRoot, ".cline", "skills");
        }

        private IEnumerable<string> GetWorkspaceSkillsDirectories()
        {
            if (string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                return Enumerable.Empty<string>();
            }

            return new[]
            {
                Path.Combine(_workspaceRoot, ".cline", "skills"),
                Path.Combine(_workspaceRoot, ".clinerules", "skills"),
                Path.Combine(_workspaceRoot, ".claude", "skills")
            };
        }

        private IEnumerable<string> GetClineRuleFiles(string directory)
        {
            return SafeEnumerateFiles(directory, "*", SearchOption.TopDirectoryOnly)
                .Where(path => IsSupportedRuleFile(path, allowExtensionless: false));
        }

        private IEnumerable<string> GetWorkflowFiles(string directory)
        {
            return SafeEnumerateFiles(directory, "*", SearchOption.TopDirectoryOnly)
                .Where(path => IsSupportedRuleFile(path, allowExtensionless: true));
        }

        private IEnumerable<string> GetCursorRuleFiles()
        {
            if (string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                return Enumerable.Empty<string>();
            }

            var candidates = new[]
            {
                Path.Combine(_workspaceRoot, ".cursorrules"),
                Path.Combine(_workspaceRoot, ".cursor", "rules", "rules.md")
            };

            return candidates.Where(File.Exists);
        }

        private IEnumerable<string> GetWindsurfRuleFiles()
        {
            if (string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                return Enumerable.Empty<string>();
            }

            var candidate = Path.Combine(_workspaceRoot, ".windsurfrules");
            return File.Exists(candidate) ? new[] { candidate } : Enumerable.Empty<string>();
        }

        private IEnumerable<string> GetAgentsRuleFiles()
        {
            if (string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                return Enumerable.Empty<string>();
            }

            var topLevel = Path.Combine(_workspaceRoot, "AGENTS.md");
            if (!File.Exists(topLevel))
            {
                return Enumerable.Empty<string>();
            }

            return SafeEnumerateFiles(_workspaceRoot, "AGENTS.md", SearchOption.AllDirectories)
                .Where(path => !IsIgnoredSearchPath(path));
        }

        private static bool IsPathUnderDirectory(string path, string directory)
        {
            if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(directory))
            {
                return false;
            }

            try
            {
                var fullPath = Path.GetFullPath(path)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var fullDirectory = Path.GetFullPath(directory)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    + Path.DirectorySeparatorChar;
                return fullPath.StartsWith(fullDirectory, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(fullPath, fullDirectory.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        private string EnsureSafeRelativeName(string name, bool allowExtensionless)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new InvalidOperationException("A file name is required.");
            }

            var trimmed = name.Trim().Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
            if (Path.IsPathRooted(trimmed) || trimmed.Contains(".." + Path.DirectorySeparatorChar) || trimmed == "..")
            {
                throw new InvalidOperationException("Nested or absolute paths are not allowed.");
            }

            var extension = Path.GetExtension(trimmed);
            if (string.IsNullOrEmpty(extension))
            {
                if (!allowExtensionless)
                {
                    trimmed += ".md";
                }
            }
            else if (!IsSupportedRuleFile(trimmed, allowExtensionless))
            {
                throw new InvalidOperationException("Only .md, .txt, or no extension are supported.");
            }

            return trimmed;
        }

        private string CreateRuleTemplate(string title)
        {
            return "# " + title + Environment.NewLine + Environment.NewLine;
        }

        private string CreateSkillTemplate(string skillName)
        {
            return "---" + Environment.NewLine
                + "name: " + skillName + Environment.NewLine
                + "description: Describe when this skill should be used." + Environment.NewLine
                + "---" + Environment.NewLine + Environment.NewLine
                + "# " + skillName + Environment.NewLine + Environment.NewLine;
        }

        private string CreateHookTemplate(string hookName)
        {
            return "$ErrorActionPreference = \"Stop\"" + Environment.NewLine + Environment.NewLine
                + "# " + hookName + " hook" + Environment.NewLine;
        }

        private string ParseRuleScope(JToken scopeToken)
        {
            var raw = scopeToken?.ToString() ?? string.Empty;
            if (string.Equals(raw, "REMOTE", StringComparison.OrdinalIgnoreCase) || raw == "3")
            {
                return "remote";
            }

            if (string.Equals(raw, "GLOBAL", StringComparison.OrdinalIgnoreCase) || raw == "1")
            {
                return "global";
            }

            return "local";
        }

        private string GetWorkspaceName()
        {
            if (string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                return "workspace";
            }

            var name = Path.GetFileName(_workspaceRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            return string.IsNullOrWhiteSpace(name) ? "workspace" : name;
        }

        private string GetHookPath(string hookName, bool isGlobal)
        {
            var directory = isGlobal ? GetGlobalHooksDirectory() : GetWorkspaceHooksDirectory();
            var existing = SafeEnumerateFiles(directory, hookName + ".*", SearchOption.TopDirectoryOnly).FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(existing))
            {
                return existing;
            }

            return Path.Combine(directory, hookName + ".ps1");
        }

        private string GetRuleDirectory(string type, bool isGlobal)
        {
            switch ((type ?? "cline").ToLowerInvariant())
            {
                case "agents":
                    return isGlobal
                        ? throw new InvalidOperationException("Global AGENTS.md creation is not supported.")
                        : _workspaceRoot;
                case "workflow":
                    return isGlobal ? GetGlobalWorkflowsDirectory() : GetWorkspaceWorkflowsDirectory();
                case "cline":
                    return isGlobal ? GetGlobalRulesDirectory() : GetWorkspaceRulesDirectory();
                default:
                    throw new InvalidOperationException("Unsupported rule type for file creation.");
            }
        }

        private JObject CreateRulesRefreshResponse()
        {
            var store = LoadToggleStore();
            var workspaceStore = GetOrCreateWorkspaceToggleStore(store);
            var globalClineRulesToggles = GetOrCreateObject(store, "globalClineRulesToggles");
            var localClineRulesToggles = GetOrCreateObject(workspaceStore, "localClineRulesToggles");
            var localCursorRulesToggles = GetOrCreateObject(workspaceStore, "localCursorRulesToggles");
            var localWindsurfRulesToggles = GetOrCreateObject(workspaceStore, "localWindsurfRulesToggles");
            var localAgentsRulesToggles = GetOrCreateObject(workspaceStore, "localAgentsRulesToggles");
            var localWorkflowToggles = GetOrCreateObject(workspaceStore, "localWorkflowToggles");
            var globalWorkflowToggles = GetOrCreateObject(store, "globalWorkflowToggles");

            var globalRuleFiles = GetClineRuleFiles(GetGlobalRulesDirectory()).ToList();
            var localRuleFiles = GetClineRuleFiles(GetWorkspaceRulesDirectory()).ToList();
            var cursorRuleFiles = GetCursorRuleFiles().ToList();
            var windsurfRuleFiles = GetWindsurfRuleFiles().ToList();
            var agentsRuleFiles = GetAgentsRuleFiles().ToList();
            var localWorkflowFiles = GetWorkflowFiles(GetWorkspaceWorkflowsDirectory()).ToList();
            var globalWorkflowFiles = GetWorkflowFiles(GetGlobalWorkflowsDirectory()).ToList();

            RemoveMissingToggleKeys(globalClineRulesToggles, globalRuleFiles);
            RemoveMissingToggleKeys(localClineRulesToggles, localRuleFiles);
            RemoveMissingToggleKeys(localCursorRulesToggles, cursorRuleFiles);
            RemoveMissingToggleKeys(localWindsurfRulesToggles, windsurfRuleFiles);
            RemoveMissingToggleKeys(localAgentsRulesToggles, agentsRuleFiles);
            RemoveMissingToggleKeys(localWorkflowToggles, localWorkflowFiles);
            RemoveMissingToggleKeys(globalWorkflowToggles, globalWorkflowFiles);
            SaveToggleStore(store);

            var response = new JObject
            {
                ["globalClineRulesToggles"] = new JObject { ["toggles"] = BuildToggleMap(globalRuleFiles, globalClineRulesToggles) },
                ["localClineRulesToggles"] = new JObject { ["toggles"] = BuildToggleMap(localRuleFiles, localClineRulesToggles) },
                ["localCursorRulesToggles"] = new JObject { ["toggles"] = BuildToggleMap(cursorRuleFiles, localCursorRulesToggles) },
                ["localWindsurfRulesToggles"] = new JObject { ["toggles"] = BuildToggleMap(windsurfRuleFiles, localWindsurfRulesToggles) },
                ["localAgentsRulesToggles"] = new JObject { ["toggles"] = BuildToggleMap(agentsRuleFiles, localAgentsRulesToggles) },
                ["localWorkflowToggles"] = new JObject { ["toggles"] = BuildToggleMap(localWorkflowFiles, localWorkflowToggles) },
                ["globalWorkflowToggles"] = new JObject { ["toggles"] = BuildToggleMap(globalWorkflowFiles, globalWorkflowToggles) }
            };

            _state["globalClineRulesToggles"] = ((JObject)response["globalClineRulesToggles"]["toggles"]).DeepClone();
            _state["localClineRulesToggles"] = ((JObject)response["localClineRulesToggles"]["toggles"]).DeepClone();
            _state["localCursorRulesToggles"] = ((JObject)response["localCursorRulesToggles"]["toggles"]).DeepClone();
            _state["localWindsurfRulesToggles"] = ((JObject)response["localWindsurfRulesToggles"]["toggles"]).DeepClone();
            _state["localAgentsRulesToggles"] = ((JObject)response["localAgentsRulesToggles"]["toggles"]).DeepClone();
            _state["localWorkflowToggles"] = ((JObject)response["localWorkflowToggles"]["toggles"]).DeepClone();
            _state["globalWorkflowToggles"] = ((JObject)response["globalWorkflowToggles"]["toggles"]).DeepClone();
            return response;
        }

        private JObject CreateHooksRefreshResponse()
        {
            var store = LoadToggleStore();
            var globalHookToggles = GetOrCreateObject(store, "globalHookToggles");
            var workspaceStore = GetOrCreateWorkspaceToggleStore(store);
            var localHookToggles = GetOrCreateObject(workspaceStore, "localHookToggles");

            var globalHooks = SafeEnumerateFiles(GetGlobalHooksDirectory(), "*", SearchOption.TopDirectoryOnly)
                .Select(path => new JObject
                {
                    ["name"] = Path.GetFileNameWithoutExtension(path),
                    ["enabled"] = IsEnabledByDefault(globalHookToggles, Path.GetFileNameWithoutExtension(path)),
                    ["absolutePath"] = path
                })
                .OrderBy(hook => hook.Value<string>("name"), StringComparer.OrdinalIgnoreCase)
                .ToList();

            RemoveMissingToggleKeys(globalHookToggles, globalHooks.Select(hook => hook.Value<string>("name") ?? string.Empty));

            var localHookItems = SafeEnumerateFiles(GetWorkspaceHooksDirectory(), "*", SearchOption.TopDirectoryOnly)
                .Select(path => new JObject
                {
                    ["name"] = Path.GetFileNameWithoutExtension(path),
                    ["enabled"] = IsEnabledByDefault(localHookToggles, Path.GetFileNameWithoutExtension(path)),
                    ["absolutePath"] = path
                })
                .OrderBy(hook => hook.Value<string>("name"), StringComparer.OrdinalIgnoreCase)
                .ToList();

            RemoveMissingToggleKeys(localHookToggles, localHookItems.Select(hook => hook.Value<string>("name") ?? string.Empty));
            SaveToggleStore(store);

            var workspaceHooks = new JArray();
            if (!string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                workspaceHooks.Add(new JObject
                {
                    ["workspaceName"] = GetWorkspaceName(),
                    ["hooks"] = new JArray(localHookItems)
                });
            }

            return new JObject
            {
                ["globalHooks"] = new JArray(globalHooks),
                ["workspaceHooks"] = workspaceHooks
            };
        }

        private string ParseSkillDescription(string skillFilePath)
        {
            try
            {
                var lines = File.ReadAllLines(skillFilePath);
                if (lines.Length == 0 || lines[0].Trim() != "---")
                {
                    return string.Empty;
                }

                for (var i = 1; i < lines.Length; i++)
                {
                    var line = lines[i].Trim();
                    if (line == "---")
                    {
                        break;
                    }

                    if (line.StartsWith("description:", StringComparison.OrdinalIgnoreCase))
                    {
                        return line.Substring("description:".Length).Trim().Trim('"');
                    }
                }
            }
            catch
            {
                // Ignore malformed skill metadata and fall back to the directory name.
            }

            return string.Empty;
        }

        private IEnumerable<JObject> GetSkillsFromDirectory(string directory, JObject toggles)
        {
            foreach (var skillDirectory in SafeEnumerateDirectories(directory).OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
            {
                var skillFile = Path.Combine(skillDirectory, "SKILL.md");
                if (!File.Exists(skillFile))
                {
                    continue;
                }

                yield return new JObject
                {
                    ["name"] = Path.GetFileName(skillDirectory),
                    ["path"] = skillFile,
                    ["description"] = ParseSkillDescription(skillFile),
                    ["enabled"] = IsEnabledByDefault(toggles, skillFile)
                };
            }
        }

        private JObject CreateSkillsRefreshResponse()
        {
            var store = LoadToggleStore();
            var workspaceStore = GetOrCreateWorkspaceToggleStore(store);
            var globalSkillsToggles = GetOrCreateObject(store, "globalSkillsToggles");
            var localSkillsToggles = GetOrCreateObject(workspaceStore, "localSkillsToggles");

            var globalSkills = GetSkillsFromDirectory(GetGlobalSkillsDirectory(), globalSkillsToggles).ToList();
            var localSkills = GetWorkspaceSkillsDirectories()
                .SelectMany(directory => GetSkillsFromDirectory(directory, localSkillsToggles))
                .GroupBy(skill => skill.Value<string>("path"), StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .OrderBy(skill => skill.Value<string>("name"), StringComparer.OrdinalIgnoreCase)
                .ToList();

            RemoveMissingToggleKeys(globalSkillsToggles, globalSkills.Select(skill => skill.Value<string>("path") ?? string.Empty));
            RemoveMissingToggleKeys(localSkillsToggles, localSkills.Select(skill => skill.Value<string>("path") ?? string.Empty));
            SaveToggleStore(store);

            _state["globalSkillsToggles"] = BuildToggleMap(globalSkills.Select(skill => skill.Value<string>("path") ?? string.Empty), globalSkillsToggles);
            _state["localSkillsToggles"] = BuildToggleMap(localSkills.Select(skill => skill.Value<string>("path") ?? string.Empty), localSkillsToggles);

            return new JObject
            {
                ["globalSkills"] = new JArray(globalSkills),
                ["localSkills"] = new JArray(localSkills)
            };
        }

        private JObject ToggleClineRule(JObject message)
        {
            var store = LoadToggleStore();
            var scope = ParseRuleScope(message["scope"]);
            var rulePath = message.Value<string>("rulePath") ?? string.Empty;
            var enabled = message.Value<bool?>("enabled") != false;

            if (scope == "remote")
            {
                var remoteRules = GetOrCreateObject(store, "remoteRulesToggles");
                remoteRules[rulePath] = enabled;
                SaveToggleStore(store);
                _state["remoteRulesToggles"] = remoteRules.DeepClone();
                return new JObject { ["remoteRulesToggles"] = new JObject { ["toggles"] = remoteRules.DeepClone() } };
            }

            var target = scope == "global"
                ? GetOrCreateObject(store, "globalClineRulesToggles")
                : GetOrCreateObject(GetOrCreateWorkspaceToggleStore(store), "localClineRulesToggles");
            target[rulePath] = enabled;
            SaveToggleStore(store);
            return CreateRulesRefreshResponse();
        }

        private JObject ToggleSimpleRule(JObject message, string toggleKey)
        {
            var store = LoadToggleStore();
            var workspaceStore = GetOrCreateWorkspaceToggleStore(store);
            var toggles = GetOrCreateObject(workspaceStore, toggleKey);
            var rulePath = message.Value<string>("rulePath") ?? string.Empty;
            toggles[rulePath] = message.Value<bool?>("enabled") != false;
            SaveToggleStore(store);

            var response = CreateRulesRefreshResponse();
            return (JObject)response[toggleKey];
        }

        private JObject ToggleWorkflow(JObject message)
        {
            var store = LoadToggleStore();
            var scope = ParseRuleScope(message["scope"]);
            var workflowPath = message.Value<string>("workflowPath") ?? string.Empty;
            var enabled = message.Value<bool?>("enabled") != false;

            if (scope == "remote")
            {
                var remoteWorkflows = GetOrCreateObject(store, "remoteWorkflowToggles");
                remoteWorkflows[workflowPath] = enabled;
                SaveToggleStore(store);
                _state["remoteWorkflowToggles"] = remoteWorkflows.DeepClone();
                return new JObject { ["toggles"] = remoteWorkflows.DeepClone() };
            }

            var target = scope == "global"
                ? GetOrCreateObject(store, "globalWorkflowToggles")
                : GetOrCreateObject(GetOrCreateWorkspaceToggleStore(store), "localWorkflowToggles");
            target[workflowPath] = enabled;
            SaveToggleStore(store);

            var response = CreateRulesRefreshResponse();
            return (JObject)(scope == "global"
                ? response["globalWorkflowToggles"]
                : response["localWorkflowToggles"]);
        }

        private JObject ToggleSkill(JObject message)
        {
            var store = LoadToggleStore();
            var skillPath = message.Value<string>("skillPath") ?? string.Empty;
            var enabled = message.Value<bool?>("enabled") != false;
            var isGlobal = message.Value<bool?>("isGlobal") == true || skillPath.StartsWith("remote:", StringComparison.OrdinalIgnoreCase);

            if (skillPath.StartsWith("remote:", StringComparison.OrdinalIgnoreCase))
            {
                var remoteSkills = GetOrCreateObject(store, "globalSkillsToggles");
                remoteSkills[skillPath] = enabled;
                SaveToggleStore(store);
                return new JObject { ["globalSkillsToggles"] = remoteSkills.DeepClone(), ["localSkillsToggles"] = (_state["localSkillsToggles"] as JObject ?? new JObject()).DeepClone() };
            }

            var target = isGlobal
                ? GetOrCreateObject(store, "globalSkillsToggles")
                : GetOrCreateObject(GetOrCreateWorkspaceToggleStore(store), "localSkillsToggles");
            target[skillPath] = enabled;
            SaveToggleStore(store);
            CreateSkillsRefreshResponse();
            return new JObject
            {
                ["globalSkillsToggles"] = (_state["globalSkillsToggles"] as JObject ?? new JObject()).DeepClone(),
                ["localSkillsToggles"] = (_state["localSkillsToggles"] as JObject ?? new JObject()).DeepClone()
            };
        }

        private JObject ToggleHook(JObject message)
        {
            var store = LoadToggleStore();
            var isGlobal = message.Value<bool?>("isGlobal") == true;
            var hookName = message.Value<string>("hookName") ?? string.Empty;
            var target = isGlobal
                ? GetOrCreateObject(store, "globalHookToggles")
                : GetOrCreateObject(GetOrCreateWorkspaceToggleStore(store), "localHookToggles");
            target[hookName] = message.Value<bool?>("enabled") != false;
            SaveToggleStore(store);
            return new JObject { ["hooksToggles"] = CreateHooksRefreshResponse() };
        }

        private async Task<JObject> CreateRuleFileAsync(JObject message)
        {
            var isGlobal = message.Value<bool?>("isGlobal") == true;
            var type = message.Value<string>("type") ?? "cline";
            var filename = string.Equals(type, "agents", StringComparison.OrdinalIgnoreCase)
                ? "AGENTS.md"
                : EnsureSafeRelativeName(message.Value<string>("filename") ?? string.Empty, allowExtensionless: string.Equals(type, "workflow", StringComparison.OrdinalIgnoreCase));
            var directory = GetRuleDirectory(type, isGlobal);
            Directory.CreateDirectory(directory);

            var fullPath = Path.Combine(directory, filename);
            if (File.Exists(fullPath))
            {
                throw new InvalidOperationException("The file already exists.");
            }

            File.WriteAllText(fullPath, CreateRuleTemplate(Path.GetFileNameWithoutExtension(fullPath)));
            await _editorService.OpenFileAsync(fullPath, null);
            return CreateRulesRefreshResponse();
        }

        private async Task<JObject> DeleteRuleFileAsync(JObject message)
        {
            var rulePath = message.Value<string>("rulePath") ?? string.Empty;
            var isGlobal = message.Value<bool?>("isGlobal") == true;
            var type = (message.Value<string>("type") ?? "cline").ToLowerInvariant();

            var allowed = type == "agents"
                ? !string.IsNullOrWhiteSpace(_workspaceRoot) && string.Equals(Path.GetFileName(rulePath), "AGENTS.md", StringComparison.OrdinalIgnoreCase) && IsPathUnderDirectory(rulePath, _workspaceRoot)
                : IsPathUnderDirectory(rulePath, GetRuleDirectory(type, isGlobal));

            if (!allowed || !File.Exists(rulePath))
            {
                throw new InvalidOperationException("The requested file cannot be deleted.");
            }

            File.Delete(rulePath);
            await Task.CompletedTask;
            return CreateRulesRefreshResponse();
        }

        private async Task<JObject> CreateHookAsync(JObject message)
        {
            var hookName = message.Value<string>("hookName") ?? string.Empty;
            var isGlobal = message.Value<bool?>("isGlobal") == true;
            var path = GetHookPath(hookName, isGlobal);
            Directory.CreateDirectory(Path.GetDirectoryName(path));

            if (!File.Exists(path))
            {
                File.WriteAllText(path, CreateHookTemplate(hookName));
            }

            await _editorService.OpenFileAsync(path, null);
            return new JObject { ["hooksToggles"] = CreateHooksRefreshResponse() };
        }

        private async Task<JObject> DeleteHookAsync(JObject message)
        {
            var hookName = message.Value<string>("hookName") ?? string.Empty;
            var isGlobal = message.Value<bool?>("isGlobal") == true;
            var path = GetHookPath(hookName, isGlobal);
            if (File.Exists(path))
            {
                File.Delete(path);
            }

            var store = LoadToggleStore();
            var target = isGlobal
                ? GetOrCreateObject(store, "globalHookToggles")
                : GetOrCreateObject(GetOrCreateWorkspaceToggleStore(store), "localHookToggles");
            target.Remove(hookName);
            SaveToggleStore(store);

            await Task.CompletedTask;
            return new JObject { ["hooksToggles"] = CreateHooksRefreshResponse() };
        }

        private async Task<JObject> CreateSkillFileAsync(JObject message)
        {
            var skillName = message.Value<string>("skillName") ?? string.Empty;
            if (!skillName.All(ch => char.IsLetterOrDigit(ch) || ch == '-' || ch == '_'))
            {
                throw new InvalidOperationException("Skill names may only contain letters, numbers, dashes, and underscores.");
            }

            var isGlobal = message.Value<bool?>("isGlobal") == true;
            var directory = Path.Combine(isGlobal ? GetGlobalSkillsDirectory() : GetWorkspaceSkillsDirectory(), skillName);
            Directory.CreateDirectory(directory);
            var skillFile = Path.Combine(directory, "SKILL.md");
            if (File.Exists(skillFile))
            {
                throw new InvalidOperationException("The skill already exists.");
            }

            File.WriteAllText(skillFile, CreateSkillTemplate(skillName));
            await _editorService.OpenFileAsync(skillFile, null);
            return CreateSkillsRefreshResponse();
        }

        private async Task<JObject> DeleteSkillFileAsync(JObject message)
        {
            var skillPath = message.Value<string>("skillPath") ?? string.Empty;
            var isGlobal = message.Value<bool?>("isGlobal") == true;
            var skillFile = File.Exists(skillPath) ? skillPath : Path.Combine(skillPath, "SKILL.md");
            var isAllowed = isGlobal
                ? IsPathUnderDirectory(skillFile, GetGlobalSkillsDirectory())
                : GetWorkspaceSkillsDirectories().Any(directory => IsPathUnderDirectory(skillFile, directory));
            if (!isAllowed)
            {
                throw new InvalidOperationException("The requested skill cannot be deleted.");
            }

            var skillDirectory = Path.GetDirectoryName(skillFile);
            if (!string.IsNullOrWhiteSpace(skillDirectory) && Directory.Exists(skillDirectory))
            {
                Directory.Delete(skillDirectory, recursive: true);
            }

            var store = LoadToggleStore();
            var target = isGlobal
                ? GetOrCreateObject(store, "globalSkillsToggles")
                : GetOrCreateObject(GetOrCreateWorkspaceToggleStore(store), "localSkillsToggles");
            target.Remove(skillFile);
            SaveToggleStore(store);

            await Task.CompletedTask;
            return CreateSkillsRefreshResponse();
        }

        private async Task CopyToClipboardAsync(string text)
        {
            await Application.Current.Dispatcher.InvokeAsync(() => Clipboard.SetText(text ?? ""));
        }

        private static JObject CreateEmptyCreditsResponse()
        {
            return new JObject
            {
                ["balance"] = new JObject
                {
                    ["currentBalance"] = null
                },
                ["usageTransactions"] = new JArray(),
                ["paymentTransactions"] = new JArray()
            };
        }

        private static string CreateRequestyAuthUrl(string? configuredBaseUrl)
        {
            if (!string.IsNullOrWhiteSpace(configuredBaseUrl))
            {
                return configuredBaseUrl;
            }

            return "https://app.requesty.ai/";
        }

        private void OnAgentEvent(object sender, AgentEvent e)
        {
            _ = HandleAgentEventAsync(e);
        }

        private async Task HandleAgentEventAsync(AgentEvent e)
        {
            switch (e.Type)
            {
                case "agentStatus":
                    if (e.Status == "thinking")
                    {
                        StartApiRequest();
                    }
                    else if (e.Status == "idle")
                    {
                        CompleteApiRequest();
                    }
                    break;
                case "assistantText":
                    CompleteApiRequest();
                    AddMessage(new JObject
                    {
                        ["type"] = "say",
                        ["say"] = "text",
                        ["text"] = e.Content
                    });
                    break;
                case "toolResult":
                    CompleteApiRequest();
                    await AddToolResultMessageAsync(e);
                    break;
                case "awaitingApproval":
                    CompleteApiRequest();
                    AddApprovalMessage(e);
                    break;
                case "askUser":
                    CompleteApiRequest();
                    _pendingAskType = "followup";
                    AddMessage(new JObject
                    {
                        ["type"] = "ask",
                        ["ask"] = "followup",
                        ["text"] = e.Content,
                        ["options"] = e.Options != null ? new JArray(e.Options) : new JArray()
                    });
                    break;
                case "taskCompleted":
                    CompleteApiRequest();
                    await AddCompletionMessageAsync(e.Content);
                    break;
                case "error":
                    FailCurrentTask(e.Content);
                    break;
            }

            await BroadcastStateAsync();
        }

        private void AddApprovalMessage(AgentEvent e)
        {
            if (string.Equals(e.ToolName, "execute_command", StringComparison.OrdinalIgnoreCase))
            {
                _pendingAskType = "command";
                AddMessage(new JObject
                {
                    ["type"] = "ask",
                    ["ask"] = "command",
                    ["text"] = JObject.FromObject(new
                    {
                        command = e.ToolParams != null && e.ToolParams.ContainsKey("command") ? e.ToolParams["command"] : "",
                        description = e.Content
                    }).ToString()
                });
                return;
            }

            _pendingAskType = "tool";
            AddMessage(new JObject
            {
                ["type"] = "ask",
                ["ask"] = "tool",
                ["text"] = BuildToolPayload(e.ToolName, e.ToolParams, e.Content).ToString()
            });
        }

        private async Task AddToolResultMessageAsync(AgentEvent e)
        {
            if (string.Equals(e.ToolName, "execute_command", StringComparison.OrdinalIgnoreCase))
            {
                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "command_output",
                    ["text"] = e.Content,
                    ["partial"] = false,
                    ["commandCompleted"] = true,
                    ["toolName"] = e.ToolName,
                    ["toolParams"] = e.ToolParams != null ? JObject.FromObject(e.ToolParams) : new JObject()
                });
                await SaveCheckpointAsync(e.ToolName, isAttemptCompletionMessage: false, completionMessageTs: null);
                return;
            }

            AddMessage(new JObject
            {
                ["type"] = "say",
                ["say"] = "tool",
                ["text"] = BuildToolPayload(e.ToolName, e.ToolParams, e.Content).ToString(),
                ["toolName"] = e.ToolName,
                ["toolParams"] = e.ToolParams != null ? JObject.FromObject(e.ToolParams) : new JObject()
            });
            await SaveCheckpointAsync(e.ToolName, isAttemptCompletionMessage: false, completionMessageTs: null);
        }

        private async Task AddCompletionMessageAsync(string content)
        {
            _currentTaskCompleted = true;
            _pendingAskType = "completion_result";
            UpdateCurrentTaskItem();
            var completionMessageTs = AddMessage(new JObject
            {
                ["type"] = "say",
                ["say"] = "completion_result",
                ["text"] = content
            });
            AddMessage(new JObject
            {
                ["type"] = "ask",
                ["ask"] = "completion_result",
                ["text"] = content
            });

            await SaveCheckpointAsync("attempt_completion", isAttemptCompletionMessage: true, completionMessageTs);
            SaveCurrentTaskSnapshot();
        }

        private long AddMessage(JObject message)
        {
            var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + _messageSequence++;
            message["ts"] = ts;
            var messages = (JArray)_state["clineMessages"];
            messages.Add(message);
            return ts;
        }

        private void SaveCurrentTaskSnapshot()
        {
            if (string.IsNullOrWhiteSpace(_currentTaskId))
            {
                return;
            }

            var currentTaskItem = (_state["currentTaskItem"] as JObject)?.DeepClone() as JObject;
            if (currentTaskItem == null)
            {
                return;
            }

            var snapshot = new TaskSnapshot
            {
                TaskItem = currentTaskItem,
                Messages = ((JArray)_state["clineMessages"]).DeepClone() as JArray ?? new JArray(),
                IsCompleted = _currentTaskCompleted,
                PendingAskType = _pendingAskType,
                PendingAskMessage = GetPendingAskMessageSnapshot((JArray)_state["clineMessages"], _pendingAskType),
                ApiHistory = _agentController.GetApiHistorySnapshot()
            };

            _taskSnapshots[_currentTaskId] = snapshot;
            UpsertHistoryItem(currentTaskItem);
        }

        private string? GetTaskTextFromMessages(JArray messages)
        {
            return messages
                .OfType<JObject>()
                .FirstOrDefault(item => string.Equals(item.Value<string>("say"), "task", StringComparison.Ordinal))
                ?.Value<string>("text");
        }

        private static bool IsTaskCompletedFromMessages(JArray messages)
        {
            var lastAsk = messages
                .OfType<JObject>()
                .LastOrDefault(item => string.Equals(item.Value<string>("type"), "ask", StringComparison.Ordinal));

            return string.Equals(lastAsk?.Value<string>("ask"), "completion_result", StringComparison.Ordinal)
                || string.Equals(lastAsk?.Value<string>("ask"), "resume_completed_task", StringComparison.Ordinal);
        }

        private static List<ChatMessage> BuildResumeChatHistoryFromMessages(JArray messages)
        {
            var recentMessages = messages
                .OfType<JObject>()
                .Where(ShouldIncludeResumeHistoryMessage)
                .ToList();
            var history = new List<ChatMessage>();
            foreach (var message in recentMessages)
            {
                AppendResumeHistoryFromMessage(history, message);
            }
            return history;
        }

        private static bool ShouldIncludeResumeHistoryMessage(JObject message)
        {
            var type = message.Value<string>("type");
            if (string.Equals(type, "ask", StringComparison.Ordinal))
            {
                return true;
            }

            if (!string.Equals(type, "say", StringComparison.Ordinal))
            {
                return false;
            }

            var say = message.Value<string>("say");
            return string.Equals(say, "task", StringComparison.Ordinal)
                || string.Equals(say, "text", StringComparison.Ordinal)
                || string.Equals(say, "tool", StringComparison.Ordinal)
                || string.Equals(say, "command_output", StringComparison.Ordinal)
                || string.Equals(say, "error", StringComparison.Ordinal)
                || string.Equals(say, "completion_result", StringComparison.Ordinal)
                || string.Equals(say, "generate_explanation", StringComparison.Ordinal)
                || string.Equals(say, "user_feedback", StringComparison.Ordinal)
                || string.Equals(say, "info", StringComparison.Ordinal);
        }

        private static void AppendResumeHistoryFromMessage(List<ChatMessage> history, JObject message)
        {
            var type = message.Value<string>("type");
            if (string.Equals(type, "ask", StringComparison.Ordinal))
            {
                var ask = message.Value<string>("ask") ?? "unknown";
                var askContent = BuildResumeAskSummary(ask, message);
                history.Add(ChatMessage.Assistant(askContent));
                return;
            }

            var say = message.Value<string>("say") ?? "message";
            var content = NormalizeResumeContextText(message.Value<string>("text"));
            if (string.IsNullOrWhiteSpace(content))
            {
                return;
            }

            AppendResumeToolIntent(history, say, message);

            var chatMessage = say switch
            {
                "task" => ChatMessage.User(BuildResumeTaskSummary(message, content)),
                "text" => ChatMessage.Assistant(content),
                "error" => ChatMessage.Assistant($"Error: {content}"),
                "completion_result" => ChatMessage.Assistant($"Completion result: {content}"),
                "generate_explanation" => ChatMessage.Assistant(BuildResumeExplanationSummary(content)),
                "info" => ChatMessage.Assistant($"Info: {content}"),
                "tool" => ChatMessage.User($"Tool result: {content}"),
                "command_output" => ChatMessage.User($"Command output: {content}"),
                "user_feedback" => ChatMessage.User(content),
                _ => null
            };

            if (chatMessage != null)
            {
                history.Add(chatMessage);
            }
        }

        private static string BuildResumeTaskSummary(JObject message, string content)
        {
            var builder = new StringBuilder();
            builder.Append("Task: ");
            builder.Append(content);

            var files = (message["files"] as JArray)
                ?.Values<string>()
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .Take(6)
                .ToList();
            if (files != null && files.Count > 0)
            {
                builder.Append(" | Files: ");
                builder.Append(string.Join(", ", files.Select(NormalizeResumeContextText)));
            }

            var images = (message["images"] as JArray)
                ?.Values<string>()
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .Take(4)
                .ToList();
            if (images != null && images.Count > 0)
            {
                builder.Append(" | Images: ");
                builder.Append(string.Join(", ", images.Select(NormalizeResumeContextText)));
            }

            return builder.ToString();
        }

        private static string BuildResumeExplanationSummary(string content)
        {
            if (!TryParseAskPayload(content, out var payload))
            {
                return $"Explain changes: {content}";
            }

            var title = NormalizeResumeContextText(payload?.Value<string>("title"));
            var status = NormalizeResumeContextText(payload?.Value<string>("status"));
            var fromRef = NormalizeResumeContextText(payload?.Value<string>("fromRef"));
            var toRef = NormalizeResumeContextText(payload?.Value<string>("toRef"));
            var summary = NormalizeResumeContextText(payload?.Value<string>("summary"));
            var commentsCount = (payload?["comments"] as JArray)?.Count ?? 0;

            var builder = new StringBuilder();
            builder.Append(string.IsNullOrWhiteSpace(title) ? "Explain changes" : title);
            if (!string.IsNullOrWhiteSpace(status))
            {
                builder.Append(" (");
                builder.Append(status);
                builder.Append(")");
            }
            if (!string.IsNullOrWhiteSpace(fromRef) || !string.IsNullOrWhiteSpace(toRef))
            {
                builder.Append(": ");
                builder.Append(fromRef);
                builder.Append(" -> ");
                builder.Append(toRef);
            }
            if (!string.IsNullOrWhiteSpace(summary))
            {
                builder.Append(". Summary: ");
                builder.Append(summary);
            }
            if (commentsCount > 0)
            {
                builder.Append(". Comments: ");
                builder.Append(commentsCount);
            }
            return builder.ToString();
        }

        private static void AppendResumeToolIntent(List<ChatMessage> history, string say, JObject message)
        {
            if (!string.Equals(say, "tool", StringComparison.Ordinal)
                && !string.Equals(say, "command_output", StringComparison.Ordinal))
            {
                return;
            }

            var toolName = message.Value<string>("toolName");
            if (string.IsNullOrWhiteSpace(toolName))
            {
                return;
            }

            var toolParams = message["toolParams"] as JObject;
            var toolSummary = BuildResumeToolIntentSummary(toolName, toolParams);
            if (!string.IsNullOrWhiteSpace(toolSummary))
            {
                history.Add(ChatMessage.Assistant(toolSummary));
            }
        }

        private static string BuildResumeToolIntentSummary(string toolName, JObject? toolParams)
        {
            var summary = new StringBuilder();
            summary.Append("Assistant used tool ");
            summary.Append(toolName);

            if (toolParams == null || !toolParams.Properties().Any())
            {
                return summary.ToString();
            }

            var renderedParams = toolParams.Properties()
                .Select(property => new
                {
                    property.Name,
                    Value = NormalizeResumeContextText(property.Value?.ToString())
                })
                .Where(property => !string.IsNullOrWhiteSpace(property.Value))
                .Take(4)
                .Select(property => property.Name + ": " + property.Value)
                .ToList();

            if (renderedParams.Count == 0)
            {
                return summary.ToString();
            }

            summary.Append(" with ");
            summary.Append(string.Join(", ", renderedParams));
            return summary.ToString();
        }

        private static string BuildResumeAskSummary(string ask, JObject message)
        {
            var text = NormalizeResumeContextText(message.Value<string>("text"));
            if (string.Equals(ask, "followup", StringComparison.Ordinal))
            {
                var options = (message["options"] as JArray)
                    ?.Values<string>()
                    .Where(option => !string.IsNullOrWhiteSpace(option))
                    .Take(6)
                    .ToList();
                if (options != null && options.Count > 0)
                {
                    return string.IsNullOrWhiteSpace(text)
                        ? $"Assistant requested follow-up input with options: {string.Join(", ", options)}"
                        : $"Assistant asked follow-up: {text}. Options: {string.Join(", ", options)}";
                }

                return string.IsNullOrWhiteSpace(text)
                    ? "Assistant requested follow-up input"
                    : $"Assistant asked follow-up: {text}";
            }

            if (string.Equals(ask, "command", StringComparison.Ordinal))
            {
                if (TryParseAskPayload(text, out var payload))
                {
                    var command = NormalizeResumeContextText(payload?.Value<string>("command"));
                    var description = NormalizeResumeContextText(payload?.Value<string>("description"));
                    if (!string.IsNullOrWhiteSpace(command) && !string.IsNullOrWhiteSpace(description))
                    {
                        return $"Assistant requested command approval for '{command}': {description}";
                    }

                    if (!string.IsNullOrWhiteSpace(command))
                    {
                        return $"Assistant requested command approval for '{command}'";
                    }
                }
            }

            if (string.Equals(ask, "tool", StringComparison.Ordinal))
            {
                if (TryParseAskPayload(text, out var payload))
                {
                    var tool = NormalizeResumeContextText(payload?.Value<string>("tool"));
                    var description = NormalizeResumeContextText(payload?.Value<string>("content"));
                    if (!string.IsNullOrWhiteSpace(tool) && !string.IsNullOrWhiteSpace(description))
                    {
                        return $"Assistant requested tool approval for {tool}: {description}";
                    }

                    if (!string.IsNullOrWhiteSpace(tool))
                    {
                        return $"Assistant requested tool approval for {tool}";
                    }
                }
            }

            return string.IsNullOrWhiteSpace(text)
                ? $"Assistant requested: {ask}"
                : $"Assistant requested ({ask}): {text}";
        }

        private static bool TryParseAskPayload(string text, out JObject? payload)
        {
            payload = null;
            if (string.IsNullOrWhiteSpace(text) || !text.TrimStart().StartsWith("{", StringComparison.Ordinal))
            {
                return false;
            }

            try
            {
                payload = JObject.Parse(text);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string NormalizeResumeContextText(string? text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return string.Empty;
            }

            var normalized = text.Replace("\r", " ").Replace("\n", " ").Trim();
            return normalized.Length > 400 ? normalized.Substring(0, 400) + "..." : normalized;
        }

        private void UpsertHistoryItem(JObject taskItem)
        {
            var history = (JArray)_state["taskHistory"];
            var id = taskItem.Value<string>("id");
            if (string.IsNullOrWhiteSpace(id))
            {
                return;
            }

            var existing = history
                .OfType<JObject>()
                .FirstOrDefault(item => string.Equals(item.Value<string>("id"), id, StringComparison.Ordinal));

            if (existing != null)
            {
                existing.Replace(taskItem.DeepClone());
            }
            else
            {
                history.Insert(0, taskItem.DeepClone());
            }
        }

        private List<JObject> GetTaskHistory()
        {
            return ((JArray)_state["taskHistory"]).OfType<JObject>().Select(item => (JObject)item.DeepClone()).ToList();
        }

        private async Task ShowTaskWithIdAsync(string? taskId)
        {
            if (string.IsNullOrWhiteSpace(taskId) || !_taskSnapshots.TryGetValue(taskId, out var snapshot))
            {
                return;
            }

            if (!string.IsNullOrWhiteSpace(_currentTaskId)
                && !string.Equals(_currentTaskId, taskId, StringComparison.Ordinal))
            {
                SaveCurrentTaskSnapshot();
                _agentController.Stop();
            }

            _currentTaskId = taskId;
            _workspaceRoot = snapshot.TaskItem.Value<string>("cwdOnTaskInitialization") ?? _workspaceRoot;
            _currentTaskCompleted = snapshot.IsCompleted;
            _currentTaskText = snapshot.TaskItem.Value<string>("task") ?? "";
            _pendingAskType = !string.IsNullOrWhiteSpace(snapshot.PendingAskType)
                ? snapshot.PendingAskType
                : (snapshot.IsCompleted ? "resume_completed_task" : "resume_task");
            ResetRuntimeProgressState();
            _checkpointResumeHistorySeed = snapshot.ApiHistory.Count > 0 ? snapshot.ApiHistory : null;
            _state["currentTaskItem"] = snapshot.TaskItem.DeepClone();
            _state["clineMessages"] = snapshot.Messages.DeepClone();
            AddPendingAskMessage((JArray)_state["clineMessages"], _pendingAskType, snapshot.PendingAskMessage);
            await BroadcastStateAsync();
        }

        private void DeleteTasks(JArray? ids)
        {
            if (ids == null)
            {
                return;
            }

            var idSet = new HashSet<string>(ids.Values<string>().Where(id => !string.IsNullOrWhiteSpace(id)));
            foreach (var id in idSet)
            {
                _taskSnapshots.Remove(id);
            }

            var filtered = new JArray(
                ((JArray)_state["taskHistory"])
                    .OfType<JObject>()
                    .Where(item => !idSet.Contains(item.Value<string>("id") ?? "")));
            _state["taskHistory"] = filtered;

            if (_currentTaskId != null && idSet.Contains(_currentTaskId))
            {
                ClearCurrentTask(preserveHistory: true);
            }
        }

        private async Task<JObject> HandleTaskCompletionViewChangesAsync(JObject message)
        {
            if (!AreCheckpointsEnabled())
            {
                return CreateUnsupportedTaskOperationResponse("Checkpoints are disabled in settings.");
            }

            var timestamp = message.Value<long?>("value");
            if (!timestamp.HasValue)
            {
                return CreateUnsupportedTaskOperationResponse("Checkpoint-backed 'View Changes' requires a completion message timestamp.");
            }

            var diffText = await BuildTaskCompletionDiffAsync(timestamp.Value);
            if (diffText == null)
            {
                return CreateUnsupportedTaskOperationResponse("No checkpoint diff is available for this task completion.");
            }

            if (string.IsNullOrWhiteSpace(diffText))
            {
                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "info",
                    ["text"] = "No file changes were found for this task completion."
                });
                await BroadcastStateAsync();
                await BroadcastRelinquishControlAsync();
                return new JObject();
            }

            var path = WriteWorkspaceTempFile(_currentTaskId ?? "checkpoint", "completion-diff", ".diff", diffText);
            await _editorService.OpenFileAsync(path, null);
            await BroadcastRelinquishControlAsync();
            return new JObject();
        }

        private async Task<JObject> HandleExplainChangesAsync(JObject message)
        {
            if (!AreCheckpointsEnabled())
            {
                return CreateUnsupportedTaskOperationResponse("Checkpoints are disabled in settings.");
            }

            var messageTs = message.Value<long?>("messageTs");
            if (!messageTs.HasValue)
            {
                return CreateUnsupportedTaskOperationResponse("Checkpoint-backed 'Explain Changes' requires a completion message timestamp.");
            }

            var checkpointRange = TryGetTaskCompletionCheckpointRange(messageTs.Value);
            if (checkpointRange == null)
            {
                return CreateUnsupportedTaskOperationResponse("No checkpoint diff is available for this task completion.");
            }

            var diffText = await BuildTaskCompletionDiffAsync(messageTs.Value);
            if (diffText == null)
            {
                return CreateUnsupportedTaskOperationResponse("No checkpoint diff is available for this task completion.");
            }

            if (string.IsNullOrWhiteSpace(diffText))
            {
                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "info",
                    ["text"] = "No file changes were found for this task completion."
                });
                await BroadcastStateAsync();
                await BroadcastRelinquishControlAsync();
                return new JObject();
            }

            var diffPath = WriteWorkspaceTempFile(_currentTaskId ?? "checkpoint", "explain-changes-diff", ".diff", diffText);
            await _editorService.OpenFileAsync(diffPath, null);

            var explanationStatusTs = AddMessage(new JObject
            {
                ["type"] = "say",
                ["say"] = "generate_explanation",
                ["text"] = JsonConvert.SerializeObject(new
                {
                    title = "code changes",
                    fromRef = ShortRef(checkpointRange.FromHash),
                    toRef = ShortRef(checkpointRange.ToHash),
                    status = "generating"
                })
            });
            await BroadcastStateAsync();

            try
            {
                string explanation;
                using (var llm = new LlmClient())
                {
                    llm.Configure(_settingsService.Load());
                    explanation = await llm.ChatAsync(BuildExplainChangesPrompt(diffText, checkpointRange));
                }

                var explanationComments = ParseExplainChangesComments(explanation);
                var explanationDocument = BuildExplanationDocument(explanation, checkpointRange);
                var explanationPath = WriteWorkspaceTempFile(_currentTaskId ?? "checkpoint", "explain-changes", ".md", explanationDocument);
                await _editorService.OpenFileAsync(explanationPath, null);

                UpdateMessageText(explanationStatusTs, JsonConvert.SerializeObject(new
                {
                    title = "code changes",
                    fromRef = ShortRef(checkpointRange.FromHash),
                    toRef = ShortRef(checkpointRange.ToHash),
                    status = "complete",
                    summary = explanationComments.Count == 0 ? explanation.Trim() : null,
                    comments = explanationComments.Select(comment => new
                    {
                        filePath = comment.FilePath,
                        line = comment.Line,
                        body = comment.Body
                    }).ToArray()
                }));
                await BroadcastStateAsync();
                await BroadcastRelinquishControlAsync();
                return new JObject();
            }
            catch (Exception ex)
            {
                UpdateMessageText(explanationStatusTs, JsonConvert.SerializeObject(new
                {
                    title = "code changes",
                    fromRef = ShortRef(checkpointRange.FromHash),
                    toRef = ShortRef(checkpointRange.ToHash),
                    status = "error",
                    error = ex.Message
                }));
                await BroadcastStateAsync();
                await BroadcastRelinquishControlAsync();
                return CreateUnsupportedTaskOperationResponse("Failed to explain changes: " + ex.Message);
            }
        }

        private void ToggleTaskFavorite(string? taskId, bool isFavorited)
        {
            if (string.IsNullOrWhiteSpace(taskId))
            {
                return;
            }

            foreach (var item in ((JArray)_state["taskHistory"]).OfType<JObject>())
            {
                if (string.Equals(item.Value<string>("id"), taskId, StringComparison.Ordinal))
                {
                    item["isFavorited"] = isFavorited;
                }
            }

            if (_taskSnapshots.TryGetValue(taskId, out var snapshot))
            {
                snapshot.TaskItem["isFavorited"] = isFavorited;
            }
        }

        private void ClearCurrentTask(bool preserveHistory)
        {
            if (!preserveHistory)
            {
                ((JArray)_state["taskHistory"]).RemoveAll();
                _taskSnapshots.Clear();
            }

            ResetRuntimeProgressState();
            _currentTaskCompleted = false;
            _currentTaskText = "";
            _pendingAskType = null;
            _checkpointResumeHistorySeed = null;
            _currentTaskId = null;
            _state["currentTaskItem"] = null;
            _state["clineMessages"] = new JArray();
        }

        private void ResetRuntimeProgressState()
        {
            _apiRequestInProgress = false;
            _state["backgroundCommandRunning"] = false;
        }

        private void StartApiRequest()
        {
            if (_apiRequestInProgress)
            {
                return;
            }

            _apiRequestInProgress = true;
            _state["backgroundCommandRunning"] = true;
            AddMessage(new JObject
            {
                ["type"] = "say",
                ["say"] = "api_req_started",
                ["text"] = JObject.FromObject(new
                {
                    request = "visual-studio-agent",
                    model = _settingsService.Load().ModelName
                }).ToString(),
                ["partial"] = true
            });
            UpdateCurrentTaskItem();
        }

        private void CompleteApiRequest()
        {
            if (!_apiRequestInProgress)
            {
                return;
            }

            _apiRequestInProgress = false;
            _state["backgroundCommandRunning"] = false;
            AddMessage(new JObject
            {
                ["type"] = "say",
                ["say"] = "api_req_finished",
                ["text"] = JObject.FromObject(new
                {
                    tokensIn = 0,
                    tokensOut = 0,
                    cacheWrites = 0,
                    cacheReads = 0,
                    cost = 0
                }).ToString()
            });
            UpdateCurrentTaskItem();
        }

        private void CancelCurrentTask(string message)
        {
            _agentController.Stop();
            CompleteApiRequest();
            _pendingAskType = "resume_task";
            UpdateCurrentTaskItem();
            AddMessage(new JObject
            {
                ["type"] = "say",
                ["say"] = "info",
                ["text"] = message
            });
            AddMessage(new JObject
            {
                ["type"] = "ask",
                ["ask"] = "resume_task",
                ["text"] = ""
            });
            SaveCurrentTaskSnapshot();
        }

        private void FailCurrentTask(string content)
        {
            CompleteApiRequest();
            _pendingAskType = "resume_task";
            UpdateCurrentTaskItem();
            AddMessage(new JObject
            {
                ["type"] = "say",
                ["say"] = "error",
                ["text"] = content
            });
            AddMessage(new JObject
            {
                ["type"] = "ask",
                ["ask"] = "resume_task",
                ["text"] = ""
            });
            SaveCurrentTaskSnapshot();
        }

        private void UpdateCurrentTaskItem()
        {
            if (_state["currentTaskItem"] is not JObject currentTaskItem)
            {
                return;
            }

            currentTaskItem["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            currentTaskItem["size"] = ((JArray)_state["clineMessages"]).Count;
            currentTaskItem["cwdOnTaskInitialization"] = _workspaceRoot;
            currentTaskItem["modelId"] = _settingsService.Load().ModelName;
            currentTaskItem["task"] = _currentTaskText;
            var deletedRange = GetConversationHistoryDeletedRangeSnapshot((JArray)_state["clineMessages"]);
            if (deletedRange != null)
            {
                currentTaskItem["conversationHistoryDeletedRange"] = deletedRange;
            }
            else
            {
                currentTaskItem.Remove("conversationHistoryDeletedRange");
            }
        }

        private async Task SaveCheckpointAsync(string? toolName, bool isAttemptCompletionMessage, long? completionMessageTs)
        {
            if (!AreCheckpointsEnabled())
            {
                return;
            }

            if (!ShouldCreateCheckpoint(toolName, isAttemptCompletionMessage))
            {
                return;
            }

            var session = await EnsureCheckpointSessionAsync();
            if (session == null)
            {
                return;
            }

            var clineMessages = ((JArray)_state["clineMessages"]).OfType<JObject>().ToList();
            foreach (var entry in clineMessages.Where(message => string.Equals(message.Value<string>("say"), "checkpoint_created", StringComparison.Ordinal)))
            {
                entry["isCheckpointCheckedOut"] = false;
            }

            try
            {
                if (!isAttemptCompletionMessage)
                {
                    var lastMessage = clineMessages.LastOrDefault();
                    if (string.Equals(lastMessage?.Value<string>("say"), "checkpoint_created", StringComparison.Ordinal))
                    {
                        return;
                    }

                    var checkpointTs = AddMessage(new JObject
                    {
                        ["type"] = "say",
                        ["say"] = "checkpoint_created",
                        ["text"] = string.Empty,
                        ["isCheckpointCheckedOut"] = false
                    });

                    var commitHash = CreateCheckpointCommit(session);
                    if (!string.IsNullOrWhiteSpace(commitHash))
                    {
                        AttachCheckpointHash(checkpointTs, commitHash);
                    }
                }
                else
                {
                    var commitHash = CreateCheckpointCommit(session);
                    if (!string.IsNullOrWhiteSpace(commitHash) && completionMessageTs.HasValue)
                    {
                        AttachCheckpointHash(completionMessageTs.Value, commitHash);
                    }
                }

                _state["checkpointManagerErrorMessage"] = null;
            }
            catch (Exception ex)
            {
                _state["checkpointManagerErrorMessage"] = "Failed to save checkpoint: " + ex.Message;
            }

            UpdateCurrentTaskItem();
            SaveCurrentTaskSnapshot();
        }

        private bool ShouldCreateCheckpoint(string? toolName, bool isAttemptCompletionMessage)
        {
            if (isAttemptCompletionMessage)
            {
                return true;
            }

            return string.Equals(toolName, "write_to_file", StringComparison.OrdinalIgnoreCase)
                || string.Equals(toolName, "replace_in_file", StringComparison.OrdinalIgnoreCase)
                || string.Equals(toolName, "execute_command", StringComparison.OrdinalIgnoreCase);
        }

            private bool AreCheckpointsEnabled()
            {
                return _state.Value<bool?>("enableCheckpointsSetting") == true;
            }

        private async Task<CheckpointSession?> EnsureCheckpointSessionAsync()
        {
            if (string.IsNullOrWhiteSpace(_currentTaskId) || string.IsNullOrWhiteSpace(_workspaceRoot))
            {
                return null;
            }

            if (_checkpointSessions.TryGetValue(_currentTaskId, out var existingSession))
            {
                return existingSession;
            }

            var gitRoot = FindGitRoot(_workspaceRoot);
            if (string.IsNullOrWhiteSpace(gitRoot))
            {
                _state["checkpointManagerErrorMessage"] = "Checkpoints require a git-backed workspace.";
                return null;
            }

            try
            {
                RunProcessCapture("git", "--version", gitRoot);
            }
            catch (Exception ex)
            {
                _state["checkpointManagerErrorMessage"] = "Git must be installed to use checkpoints: " + ex.Message;
                return null;
            }

            var workspaceHash = ComputeStableHash(gitRoot);
            var sessionRoot = Path.Combine(GetApplicationDataDirectory(), "checkpoints", workspaceHash, _currentTaskId);
            var shadowGitRoot = Path.Combine(sessionRoot, "shadow-git");
            Directory.CreateDirectory(shadowGitRoot);

            var gitDirectory = Path.Combine(shadowGitRoot, ".git");
            if (!Directory.Exists(gitDirectory))
            {
                RunProcessCapture("git", "init --quiet", shadowGitRoot);
                RunProcessCapture("git", "config user.name \"VsClineAgent\"", shadowGitRoot);
                RunProcessCapture("git", "config user.email \"vsclineagent@local\"", shadowGitRoot);
            }

            var session = new CheckpointSession(gitRoot, shadowGitRoot);
            _checkpointSessions[_currentTaskId] = session;
            return session;
        }

        private string CreateCheckpointCommit(CheckpointSession session)
        {
            RunCheckpointGitCommand(session, "add -A .");
            RunCheckpointGitCommand(session, "commit --allow-empty --no-verify -m \"checkpoint\"");
            return RunCheckpointGitCommand(session, "rev-parse HEAD").Trim();
        }

        private void AttachCheckpointHash(long messageTs, string checkpointHash)
        {
            var message = ((JArray)_state["clineMessages"])
                .OfType<JObject>()
                .FirstOrDefault(item => item.Value<long?>("ts") == messageTs);
            if (message == null)
            {
                return;
            }

            message["lastCheckpointHash"] = checkpointHash;
            message["conversationHistoryIndex"] = Math.Max(0, ((JArray)_state["clineMessages"]).Count - 1);
            message["checkpointTaskText"] = _currentTaskText;
            message["checkpointIsCompleted"] = _currentTaskCompleted;
            message["checkpointModelId"] = _settingsService.Load().ModelName;
            message["checkpointWorkspaceRoot"] = _workspaceRoot;
            if (_state["currentTaskItem"] is JObject currentTaskItem)
            {
                message["checkpointTaskItem"] = currentTaskItem.DeepClone();
            }
            else
            {
                message.Remove("checkpointTaskItem");
            }
            var checkpointApiHistory = _agentController.GetApiHistorySnapshot();
            if (checkpointApiHistory.Count > 0)
            {
                message["checkpointApiHistory"] = JArray.FromObject(checkpointApiHistory);
            }
            else
            {
                message.Remove("checkpointApiHistory");
            }

            message["checkpointResumeHistory"] = JArray.FromObject(BuildResumeChatHistoryFromMessages((JArray)_state["clineMessages"]));
            if (!string.IsNullOrWhiteSpace(_pendingAskType))
            {
                message["checkpointPendingAskType"] = _pendingAskType;
            }
            else
            {
                message.Remove("checkpointPendingAskType");
            }

            var pendingAskMessage = GetPendingAskMessageSnapshot((JArray)_state["clineMessages"], _pendingAskType);
            if (pendingAskMessage != null)
            {
                message["checkpointPendingAskMessage"] = pendingAskMessage;
            }
            else
            {
                message.Remove("checkpointPendingAskMessage");
            }

            var conversationHistoryDeletedRange = GetConversationHistoryDeletedRangeSnapshot((JArray)_state["clineMessages"]);
            if (conversationHistoryDeletedRange != null)
            {
                message["checkpointConversationHistoryDeletedRange"] = conversationHistoryDeletedRange;
            }
            else
            {
                message.Remove("checkpointConversationHistoryDeletedRange");
            }
        }

        private void MarkCheckpointCheckoutState(string checkpointHash)
        {
            foreach (var message in ((JArray)_state["clineMessages"]).OfType<JObject>())
            {
                if (string.Equals(message.Value<string>("say"), "checkpoint_created", StringComparison.Ordinal))
                {
                    message["isCheckpointCheckedOut"] = string.Equals(
                        message.Value<string>("lastCheckpointHash"),
                        checkpointHash,
                        StringComparison.Ordinal);
                }
            }
        }

        private async Task<string?> BuildCheckpointDiffAsync(long messageTs, bool compareToCurrentWorkspace)
        {
            var clineMessages = ((JArray)_state["clineMessages"]).OfType<JObject>().ToList();
            var messageIndex = clineMessages.FindIndex(item => item.Value<long?>("ts") == messageTs);
            if (messageIndex < 0)
            {
                return null;
            }

            var checkpointHash = clineMessages[messageIndex].Value<string>("lastCheckpointHash");
            if (string.IsNullOrWhiteSpace(checkpointHash))
            {
                checkpointHash = clineMessages
                    .Take(messageIndex)
                    .LastOrDefault(item => !string.IsNullOrWhiteSpace(item.Value<string>("lastCheckpointHash")))
                    ?.Value<string>("lastCheckpointHash");
            }

            if (string.IsNullOrWhiteSpace(checkpointHash))
            {
                return null;
            }

            var session = await EnsureCheckpointSessionAsync();
            if (session == null)
            {
                return null;
            }

            var arguments = compareToCurrentWorkspace
                ? $"diff --binary --find-renames {EscapeGitArgument(checkpointHash)} --"
                : $"show --stat --patch {EscapeGitArgument(checkpointHash)}";
            return RunCheckpointGitCommand(session, arguments);
        }

        private async Task<string?> BuildTaskCompletionDiffAsync(long messageTs)
        {
            var clineMessages = ((JArray)_state["clineMessages"]).OfType<JObject>().ToList();
            var messageIndex = clineMessages.FindIndex(item => item.Value<long?>("ts") == messageTs);
            if (messageIndex < 0)
            {
                return null;
            }

            var targetMessage = clineMessages[messageIndex];
            var currentHash = targetMessage.Value<string>("lastCheckpointHash");
            if (string.IsNullOrWhiteSpace(currentHash))
            {
                return null;
            }

            var previousHash = clineMessages
                .Take(messageIndex)
                .LastOrDefault(item => string.Equals(item.Value<string>("say"), "completion_result", StringComparison.Ordinal)
                    && !string.IsNullOrWhiteSpace(item.Value<string>("lastCheckpointHash")))
                ?.Value<string>("lastCheckpointHash");

            if (string.IsNullOrWhiteSpace(previousHash))
            {
                previousHash = clineMessages
                    .FirstOrDefault(item => string.Equals(item.Value<string>("say"), "checkpoint_created", StringComparison.Ordinal)
                        && !string.IsNullOrWhiteSpace(item.Value<string>("lastCheckpointHash")))
                    ?.Value<string>("lastCheckpointHash");
            }

            if (string.IsNullOrWhiteSpace(previousHash))
            {
                return null;
            }

            var session = await EnsureCheckpointSessionAsync();
            if (session == null)
            {
                return null;
            }

            return RunCheckpointGitCommand(
                session,
                $"diff --binary --find-renames {EscapeGitArgument(previousHash)} {EscapeGitArgument(currentHash)} --");
        }

        private CheckpointRange? TryGetTaskCompletionCheckpointRange(long messageTs)
        {
            var clineMessages = ((JArray)_state["clineMessages"]).OfType<JObject>().ToList();
            var messageIndex = clineMessages.FindIndex(item => item.Value<long?>("ts") == messageTs);
            if (messageIndex < 0)
            {
                return null;
            }

            var targetMessage = clineMessages[messageIndex];
            var currentHash = targetMessage.Value<string>("lastCheckpointHash");
            if (string.IsNullOrWhiteSpace(currentHash))
            {
                return null;
            }

            var previousHash = clineMessages
                .Take(messageIndex)
                .LastOrDefault(item => string.Equals(item.Value<string>("say"), "completion_result", StringComparison.Ordinal)
                    && !string.IsNullOrWhiteSpace(item.Value<string>("lastCheckpointHash")))
                ?.Value<string>("lastCheckpointHash");

            if (string.IsNullOrWhiteSpace(previousHash))
            {
                previousHash = clineMessages
                    .FirstOrDefault(item => string.Equals(item.Value<string>("say"), "checkpoint_created", StringComparison.Ordinal)
                        && !string.IsNullOrWhiteSpace(item.Value<string>("lastCheckpointHash")))
                    ?.Value<string>("lastCheckpointHash");
            }

            return string.IsNullOrWhiteSpace(previousHash)
                ? null
                : new CheckpointRange(previousHash, currentHash, targetMessage.Value<string>("text") ?? string.Empty);
        }

        private List<ChatMessage> BuildExplainChangesPrompt(string diffText, CheckpointRange checkpointRange)
        {
            var summary = BuildRecentConversationSummary(limit: 12);
            var taskDescription = _currentTaskText;
            var prompt =
                "Explain the code changes in the provided git diff. " +
                "Only describe changes supported by the diff and task context. " +
                "Do not invent intent that is not grounded in the diff. " +
                "Focus on what changed and why it matters to the task.\n\n" +
                $"Task:\n{taskDescription}\n\n" +
                $"Completion result:\n{checkpointRange.CompletionText}\n\n" +
                $"Recent conversation summary:\n{summary}\n\n" +
                $"Diff from {ShortRef(checkpointRange.FromHash)} to {ShortRef(checkpointRange.ToHash)}:\n```diff\n{diffText}\n```\n\n" +
                "Output format:\n" +
                "@@@ FILE: relative/or/absolute/path\n" +
                "@@@ LINE: 0-based line number in the changed file\n" +
                "Short Markdown explanation for that logical change grouping\n" +
                "@@@\n\n" +
                "Rules:\n" +
                "- Cover each changed file with at least one comment when possible.\n" +
                "- Use one comment per logical change grouping, not every changed line.\n" +
                "- Prefer paths that appear in the diff.\n" +
                "- Keep explanations concise and grounded in the diff.\n" +
                "- Do not output any prose outside the @@@ blocks.";

            return new List<ChatMessage>
            {
                new ChatMessage
                {
                    Role = "system",
                    Content = "You are explaining source code changes for a coding task. Be precise, concise, and diff-grounded."
                },
                new ChatMessage
                {
                    Role = "user",
                    Content = prompt
                }
            };
        }

        private string BuildRecentConversationSummary(int limit)
        {
            var recentItems = ((JArray)_state["clineMessages"])
                .OfType<JObject>()
                .Where(item => item.Value<string>("say") != "api_req_started"
                    && item.Value<string>("say") != "api_req_finished")
                .ToList();

            var messages = recentItems
                .Skip(Math.Max(0, recentItems.Count - Math.Max(1, limit)))
                .Select(item =>
                {
                    var role = item.Value<string>("type") == "ask" ? "ask" : (item.Value<string>("say") ?? "say");
                    var text = item.Value<string>("text") ?? string.Empty;
                    if (text.Length > 300)
                    {
                        text = text.Substring(0, 300) + "...";
                    }

                    return $"[{role}] {text}";
                });

            var summary = string.Join("\n", messages).Trim();
            return string.IsNullOrWhiteSpace(summary) ? "(no recent conversation summary available)" : summary;
        }

        private static string BuildExplanationDocument(string explanation, CheckpointRange checkpointRange)
        {
            var comments = ParseExplainChangesComments(explanation);
            var builder = new StringBuilder();
            builder.AppendLine("# Explain Changes");
            builder.AppendLine();
            builder.AppendLine($"From `{ShortRef(checkpointRange.FromHash)}` to `{ShortRef(checkpointRange.ToHash)}`");
            builder.AppendLine();

            if (comments.Count > 0)
            {
                foreach (var comment in comments)
                {
                    builder.AppendLine($"## {comment.FilePath}:{comment.Line + 1}");
                    builder.AppendLine();
                    builder.AppendLine(comment.Body.Trim());
                    builder.AppendLine();
                }
            }
            else
            {
                builder.AppendLine(explanation.Trim());
            }

            return builder.ToString().TrimEnd();
        }

        private static List<ExplainChangesComment> ParseExplainChangesComments(string explanation)
        {
            var comments = new List<ExplainChangesComment>();
            if (string.IsNullOrWhiteSpace(explanation))
            {
                return comments;
            }

            string currentFile = null;
            int? currentLine = null;
            var body = new StringBuilder();

            void CommitComment()
            {
                if (string.IsNullOrWhiteSpace(currentFile) || !currentLine.HasValue)
                {
                    body.Clear();
                    return;
                }

                var text = body.ToString().Trim();
                if (text.Length == 0)
                {
                    body.Clear();
                    return;
                }

                comments.Add(new ExplainChangesComment(currentFile, currentLine.Value, text));
                body.Clear();
            }

            using (var reader = new StringReader(explanation.Replace("\r\n", "\n")))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    var trimmed = line.Trim();
                    if (trimmed.StartsWith("@@@ FILE:", StringComparison.Ordinal))
                    {
                        CommitComment();
                        currentFile = trimmed.Substring("@@@ FILE:".Length).Trim();
                        currentLine = null;
                        continue;
                    }

                    if (trimmed.StartsWith("@@@ LINE:", StringComparison.Ordinal))
                    {
                        var lineValue = trimmed.Substring("@@@ LINE:".Length).Trim();
                        currentLine = int.TryParse(lineValue, out var parsedLine) ? parsedLine : (int?)null;
                        continue;
                    }

                    if (trimmed == "@@@")
                    {
                        CommitComment();
                        currentFile = null;
                        currentLine = null;
                        continue;
                    }

                    if (body.Length > 0)
                    {
                        body.AppendLine();
                    }

                    body.Append(line);
                }
            }

            CommitComment();
            return comments;
        }

        private void UpdateMessageText(long messageTs, string text)
        {
            var message = ((JArray)_state["clineMessages"])
                .OfType<JObject>()
                .FirstOrDefault(item => item.Value<long?>("ts") == messageTs);
            if (message != null)
            {
                message["text"] = text;
            }
        }

        private static string ShortRef(string hash)
        {
            return string.IsNullOrWhiteSpace(hash)
                ? string.Empty
                : hash.Length <= 8 ? hash : hash.Substring(0, 8);
        }

        private async Task BroadcastRelinquishControlAsync()
        {
            var targets = _subscriptions.Values
                .Where(sub => sub.Service == "UiService" && sub.Method == "subscribeToRelinquishControl")
                .Select(sub => sub.RequestId)
                .ToList();

            foreach (var requestId in targets)
            {
                await SendStreamingResponseAsync(requestId, new JObject());
            }
        }

        private async Task BroadcastStateAsync()
        {
            var stateJson = _state.ToString();
            var targets = _subscriptions.Values
                .Where(sub => sub.Service == "StateService" && sub.Method == "subscribeToState")
                .Select(sub => sub.RequestId)
                .ToList();

            foreach (var requestId in targets)
            {
                await SendStreamingResponseAsync(requestId, new JObject
                {
                    ["stateJson"] = stateJson
                });
            }
        }

        private Task SendUnaryResponseAsync(string requestId, JToken message)
        {
            return _postToWebviewAsync(new
            {
                type = "grpc_response",
                grpc_response = new
                {
                    request_id = requestId,
                    message,
                    is_streaming = false
                }
            });
        }

        private Task SendStreamingResponseAsync(string requestId, JToken message)
        {
            return _postToWebviewAsync(new
            {
                type = "grpc_response",
                grpc_response = new
                {
                    request_id = requestId,
                    message,
                    is_streaming = true
                }
            });
        }

        private Task SendErrorResponseAsync(string requestId, string error)
        {
            return _postToWebviewAsync(new
            {
                type = "grpc_response",
                grpc_response = new
                {
                    request_id = requestId,
                    error,
                    is_streaming = false
                }
            });
        }

        private static JObject BuildToolPayload(string toolName, Dictionary<string, string>? toolParams, string content)
        {
            var payload = new JObject
            {
                ["tool"] = MapToolName(toolName),
                ["content"] = content
            };

            if (toolParams != null)
            {
                foreach (var pair in toolParams)
                {
                    payload[pair.Key] = pair.Value;
                }
            }

            return payload;
        }

        private static string MapToolName(string toolName)
        {
            switch (toolName)
            {
                case "read_file":
                    return "readFile";
                case "write_to_file":
                    return "newFileCreated";
                case "replace_in_file":
                    return "editedExistingFile";
                case "list_files":
                    return "listFilesRecursive";
                case "search_files":
                    return "searchFiles";
                case "list_code_definition_names":
                    return "listCodeDefinitionNames";
                case "execute_command":
                    return "executeCommand";
                default:
                    return toolName;
            }
        }

        private static void OpenExternalUrl(string? url)
        {
            if (string.IsNullOrWhiteSpace(url))
            {
                return;
            }

            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch
            {
            }
        }

        private static bool IsImagePath(string path)
        {
            var extension = Path.GetExtension(path) ?? "";
            return extension.Equals(".png", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".jpg", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".jpeg", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".gif", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".webp", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".bmp", StringComparison.OrdinalIgnoreCase);
        }

        private static string FormatAttachmentSummaryText(string? value)
        {
            var normalized = NormalizeResumeContextText(value);
            if (normalized.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
            {
                var separatorIndex = normalized.IndexOf(";base64,", StringComparison.OrdinalIgnoreCase);
                var mimeType = separatorIndex > "data:".Length
                    ? normalized.Substring("data:".Length, separatorIndex - "data:".Length)
                    : "image";
                return "[attached " + mimeType + "]";
            }

            return normalized;
        }

        private static string? TryCreateImageDataUri(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                {
                    return null;
                }

                var mimeType = GetImageMimeType(path);
                if (string.IsNullOrWhiteSpace(mimeType))
                {
                    return null;
                }

                var bytes = File.ReadAllBytes(path);
                return "data:" + mimeType + ";base64," + Convert.ToBase64String(bytes);
            }
            catch
            {
                return null;
            }
        }

        private static string? GetImageMimeType(string path)
        {
            var extension = Path.GetExtension(path) ?? "";
            if (extension.Equals(".png", StringComparison.OrdinalIgnoreCase))
            {
                return "image/png";
            }
            if (extension.Equals(".jpg", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".jpeg", StringComparison.OrdinalIgnoreCase))
            {
                return "image/jpeg";
            }
            if (extension.Equals(".gif", StringComparison.OrdinalIgnoreCase))
            {
                return "image/gif";
            }
            if (extension.Equals(".webp", StringComparison.OrdinalIgnoreCase))
            {
                return "image/webp";
            }
            if (extension.Equals(".bmp", StringComparison.OrdinalIgnoreCase))
            {
                return "image/bmp";
            }

            return null;
        }

        private static JObject CreateHistoryItem(string id, string task)
        {
            return new JObject
            {
                ["id"] = id,
                ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["task"] = task,
                ["tokensIn"] = 0,
                ["tokensOut"] = 0,
                ["cacheWrites"] = 0,
                ["cacheReads"] = 0,
                ["totalCost"] = 0,
                ["isFavorited"] = false,
                ["size"] = 0
            };
        }

        private static JObject CreateInitialState(AgentSettings settings, string workspaceRoot)
        {
            return new JObject
            {
                ["version"] = "vs2022-17.12-port",
                ["apiConfiguration"] = CreateApiConfiguration(settings),
                ["clineMessages"] = new JArray(),
                ["taskHistory"] = new JArray(),
                ["shouldShowAnnouncement"] = false,
                ["autoApprovalSettings"] = new JObject
                {
                    ["version"] = 1,
                    ["enabled"] = settings.AutoApprovalSettings.Enabled,
                    ["favorites"] = new JArray(settings.AutoApprovalSettings.Favorites ?? Enumerable.Empty<string>()),
                    ["maxRequests"] = settings.AutoApprovalSettings.MaxRequests,
                    ["actions"] = new JObject
                    {
                        ["readFiles"] = settings.AutoApprovalSettings.Actions.ReadFiles,
                        ["readFilesExternally"] = settings.AutoApprovalSettings.Actions.ReadFilesExternally,
                        ["editFiles"] = settings.AutoApprovalSettings.Actions.EditFiles,
                        ["editFilesExternally"] = settings.AutoApprovalSettings.Actions.EditFilesExternally,
                        ["executeSafeCommands"] = settings.AutoApprovalSettings.Actions.ExecuteSafeCommands,
                        ["executeAllCommands"] = settings.AutoApprovalSettings.Actions.ExecuteAllCommands,
                        ["useBrowser"] = settings.AutoApprovalSettings.Actions.UseBrowser,
                        ["useMcp"] = settings.AutoApprovalSettings.Actions.UseMcp
                    },
                    ["enableNotifications"] = settings.AutoApprovalSettings.EnableNotifications
                },
                ["browserSettings"] = new JObject
                {
                    ["viewport"] = new JObject
                    {
                        ["width"] = 900,
                        ["height"] = 600
                    },
                    ["remoteBrowserEnabled"] = false,
                    ["remoteBrowserHost"] = "http://localhost:9222",
                    ["chromeExecutablePath"] = "",
                    ["disableToolUse"] = true,
                    ["customArgs"] = ""
                },
                ["focusChainSettings"] = new JObject
                {
                    ["enabled"] = false,
                    ["remindClineInterval"] = 6
                },
                ["uiLanguage"] = "ko",
                ["preferredLanguage"] = "English",
                ["mode"] = "act",
                ["platform"] = "win32",
                ["environment"] = "production",
                ["telemetrySetting"] = "unset",
                ["distinctId"] = "vsclineagent-visualstudio",
                ["planActSeparateModelsSetting"] = true,
                ["enableCheckpointsSetting"] = settings.EnableCheckpointsSetting,
                ["checkpointManagerErrorMessage"] = settings.EnableCheckpointsSetting ? null : "Checkpoints are disabled in settings.",
                ["mcpDisplayMode"] = "plain",
                ["globalClineRulesToggles"] = new JObject(),
                ["localClineRulesToggles"] = new JObject(),
                ["localCursorRulesToggles"] = new JObject(),
                ["localWindsurfRulesToggles"] = new JObject(),
                ["localAgentsRulesToggles"] = new JObject(),
                ["localWorkflowToggles"] = new JObject(),
                ["globalWorkflowToggles"] = new JObject(),
                ["shellIntegrationTimeout"] = 4000,
                ["terminalReuseEnabled"] = true,
                ["vscodeTerminalExecutionMode"] = "vscodeTerminal",
                ["terminalOutputLineLimit"] = 500,
                ["maxConsecutiveMistakes"] = 3,
                ["defaultTerminalProfile"] = "visual-studio-command-host",
                ["isNewUser"] = false,
                ["welcomeViewCompleted"] = true,
                ["onboardingModels"] = null,
                ["mcpResponsesCollapsed"] = false,
                ["strictPlanModeEnabled"] = false,
                ["yoloModeToggled"] = false,
                ["customPrompt"] = null,
                ["useAutoCondense"] = false,
                ["subagentsEnabled"] = false,
                ["clineWebToolsEnabled"] = new JObject { ["user"] = false, ["featureFlag"] = false },
                ["worktreesEnabled"] = new JObject { ["user"] = true, ["featureFlag"] = false },
                ["favoritedModelIds"] = new JArray(),
                ["lastDismissedInfoBannerVersion"] = 0,
                ["lastDismissedModelBannerVersion"] = 0,
                ["lastDismissedCliBannerVersion"] = 0,
                ["optOutOfRemoteConfig"] = true,
                ["remoteConfigSettings"] = new JObject(),
                ["backgroundCommandRunning"] = false,
                ["backgroundEditEnabled"] = false,
                ["doubleCheckCompletionEnabled"] = false,
                ["lazyTeammateModeEnabled"] = false,
                ["showFeatureTips"] = false,
                ["globalSkillsToggles"] = new JObject(),
                ["localSkillsToggles"] = new JObject(),
                ["openAiCodexIsAuthenticated"] = false,
                ["workspaceRoots"] = string.IsNullOrWhiteSpace(workspaceRoot)
                    ? new JArray()
                    : new JArray
                    {
                        new JObject
                        {
                            ["path"] = workspaceRoot,
                            ["name"] = Path.GetFileName(workspaceRoot)
                        }
                    },
                ["primaryRootIndex"] = 0,
                ["isMultiRootWorkspace"] = false,
                ["multiRootSetting"] = new JObject { ["user"] = false, ["featureFlag"] = false },
                ["hooksEnabled"] = false,
                ["nativeToolCallSetting"] = false,
                ["enableParallelToolCalling"] = false,
                ["currentTaskItem"] = null
            };
        }

        private static JObject CreateApiConfiguration(AgentSettings settings)
        {
            var modelInfo = new JObject
            {
                ["maxTokens"] = settings.MaxTokens,
                ["contextWindow"] = settings.MaxTokens,
                ["supportsImages"] = false,
                ["supportsPromptCache"] = false,
                ["supportsReasoning"] = false,
                ["inputPrice"] = 0,
                ["outputPrice"] = 0,
                ["temperature"] = settings.Temperature
            };

            return new JObject
            {
                ["actModeApiProvider"] = "openai",
                ["planModeApiProvider"] = "openai",
                ["actModeOpenAiBaseUrl"] = settings.LlmBaseUrl,
                ["planModeOpenAiBaseUrl"] = settings.LlmBaseUrl,
                ["actModeOpenAiApiKey"] = settings.ApiKey,
                ["planModeOpenAiApiKey"] = settings.ApiKey,
                ["actModeOpenAiModelId"] = settings.ModelName,
                ["planModeOpenAiModelId"] = settings.ModelName,
                ["actModeOpenAiModelInfo"] = modelInfo.DeepClone(),
                ["planModeOpenAiModelInfo"] = modelInfo.DeepClone()
            };
        }

        private sealed class GrpcSubscription
        {
            public string RequestId { get; }
            public string Service { get; }
            public string Method { get; }

            public GrpcSubscription(string requestId, string service, string method)
            {
                RequestId = requestId;
                Service = service;
                Method = method;
            }
        }

        private sealed class TaskSnapshot
        {
            public JObject TaskItem { get; set; } = new JObject();
            public JArray Messages { get; set; } = new JArray();
            public bool IsCompleted { get; set; }
            public string? PendingAskType { get; set; }
            public JObject? PendingAskMessage { get; set; }
            public List<ChatMessage> ApiHistory { get; set; } = new List<ChatMessage>();
        }

        private sealed class CheckpointSession
        {
            public string WorkspaceRoot { get; }
            public string ShadowGitRoot { get; }

            public CheckpointSession(string workspaceRoot, string shadowGitRoot)
            {
                WorkspaceRoot = workspaceRoot;
                ShadowGitRoot = shadowGitRoot;
            }
        }

        private sealed class CheckpointRange
        {
            public string FromHash { get; }
            public string ToHash { get; }
            public string CompletionText { get; }

            public CheckpointRange(string fromHash, string toHash, string completionText)
            {
                FromHash = fromHash;
                ToHash = toHash;
                CompletionText = completionText;
            }
        }

        private sealed class ExplainChangesComment
        {
            public ExplainChangesComment(string filePath, int line, string body)
            {
                FilePath = filePath;
                Line = line;
                Body = body;
            }

            public string FilePath { get; }
            public int Line { get; }
            public string Body { get; }
        }
    }
}
