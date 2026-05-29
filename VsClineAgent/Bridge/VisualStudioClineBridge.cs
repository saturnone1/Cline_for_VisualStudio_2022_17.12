using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Win32;
using Newtonsoft.Json.Linq;
using VsClineAgent.Agent;
using VsClineAgent.Services;

namespace VsClineAgent.Bridge
{
    internal sealed class VisualStudioClineBridge
    {
        private readonly AgentController _agentController;
        private readonly SettingsService _settingsService;
        private readonly VsEditorService _editorService;
        private readonly Func<object, Task> _postToWebviewAsync;
        private readonly Dictionary<string, GrpcSubscription> _subscriptions = new Dictionary<string, GrpcSubscription>();
        private readonly Dictionary<string, TaskSnapshot> _taskSnapshots = new Dictionary<string, TaskSnapshot>();

        private JObject _state = new JObject();
        private string _workspaceRoot = "";
        private string _currentTaskText = "";
        private string? _currentTaskId;
        private string? _pendingAskType;
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
                    await SendStreamingResponseAsync(requestId, new JObject
                    {
                        ["items"] = new JArray()
                    });
                    break;
                case "McpService.subscribeToMcpServers":
                    await SendStreamingResponseAsync(requestId, new JObject
                    {
                        ["mcpServers"] = new JArray()
                    });
                    break;
                case "ModelsService.subscribeToOpenRouterModels":
                case "ModelsService.subscribeToLiteLlmModels":
                    await SendStreamingResponseAsync(requestId, new JObject
                    {
                        ["models"] = new JArray()
                    });
                    break;
                case "AccountService.subscribeToAuthStatusUpdate":
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
                case "StateService.getAvailableTerminalProfiles":
                    return new JObject
                    {
                        ["profiles"] = new JArray
                        {
                            new JObject
                            {
                                ["id"] = "default",
                                ["name"] = "Default"
                            }
                        }
                    };
                case "StateService.updateSettings":
                    ApplyStateSettings(message);
                    await BroadcastStateAsync();
                    return new JObject();
                case "StateService.setWelcomeViewCompleted":
                    _state["welcomeViewCompleted"] = message.Value<bool?>("value") ?? true;
                    await BroadcastStateAsync();
                    return new JObject();
                case "StateService.resetState":
                    ClearCurrentTask(preserveHistory: true);
                    await BroadcastStateAsync();
                    return new JObject();
                case "ModelsService.updateApiConfigurationProto":
                    ApplyApiConfiguration(message);
                    await BroadcastStateAsync();
                    return new JObject();
                case "ModelsService.getOllamaModels":
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
                case "FileService.copyToClipboard":
                    await CopyToClipboardAsync(message.Value<string>("value") ?? "");
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
                case "AccountService.getUserOrganizations":
                    return new JObject { ["organizations"] = new JArray() };
                case "AccountService.accountLoginClicked":
                    OpenExternalUrl("https://app.cline.bot");
                    return new JObject();
                case "AccountService.accountLogoutClicked":
                    return new JObject();
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
            _ = _agentController.StartTaskAsync(text, _workspaceRoot);
        }

        private async Task HandleAskResponseAsync(JObject message)
        {
            var responseType = message.Value<string>("responseType") ?? "";
            var text = message.Value<string>("text") ?? "";
            var hasText = !string.IsNullOrWhiteSpace(text);
            var pendingAskType = _pendingAskType;

            if (pendingAskType == "tool" || pendingAskType == "command")
            {
                var approved = responseType == "yesButtonClicked";
                _agentController.SetApproval(approved);
                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "user_feedback",
                    ["text"] = hasText ? text : (approved ? "Approved" : "Rejected")
                });
            }
            else if (pendingAskType == "resume_task")
            {
                if (responseType == "yesButtonClicked")
                {
                    var resumedText = hasText
                        ? $"{_currentTaskText}\n\nAdditional context:\n{text}"
                        : _currentTaskText;

                    await StartNewTaskAsync(new JObject
                    {
                        ["text"] = resumedText,
                        ["images"] = message["images"] as JArray ?? new JArray(),
                        ["files"] = message["files"] as JArray ?? new JArray()
                    });
                    return;
                }

                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "user_feedback",
                    ["text"] = hasText ? text : "Resume declined"
                });
            }
            else
            {
                _agentController.SetUserInput(text);
                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "user_feedback",
                    ["text"] = text
                });
            }

            _pendingAskType = null;
            await BroadcastStateAsync();
        }

        private void ApplyStateSettings(JObject message)
        {
            if (message["preferredLanguage"] != null)
            {
                _state["preferredLanguage"] = message.Value<string>("preferredLanguage") ?? "English";
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

            if (message["autoApprovalSettings"] is JObject autoApproval)
            {
                _state["autoApprovalSettings"] = autoApproval.DeepClone();
                var settings = _settingsService.Load();
                settings.AutoApprove = autoApproval.Value<bool?>("enabled") == true;
                _settingsService.Save(settings);
            }
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
                        imagePaths.Add(fileName);
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

        private async Task CopyToClipboardAsync(string text)
        {
            await Application.Current.Dispatcher.InvokeAsync(() => Clipboard.SetText(text ?? ""));
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
                    AddToolResultMessage(e);
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
                        ["text"] = e.Content
                    });
                    break;
                case "taskCompleted":
                    CompleteApiRequest();
                    AddCompletionMessage(e.Content);
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

        private void AddToolResultMessage(AgentEvent e)
        {
            if (string.Equals(e.ToolName, "execute_command", StringComparison.OrdinalIgnoreCase))
            {
                AddMessage(new JObject
                {
                    ["type"] = "say",
                    ["say"] = "command_output",
                    ["text"] = e.Content,
                    ["partial"] = false,
                    ["commandCompleted"] = true
                });
                return;
            }

            AddMessage(new JObject
            {
                ["type"] = "say",
                ["say"] = "tool",
                ["text"] = BuildToolPayload(e.ToolName, e.ToolParams, e.Content).ToString()
            });
        }

        private void AddCompletionMessage(string content)
        {
            _currentTaskCompleted = true;
            _pendingAskType = "completion_result";
            UpdateCurrentTaskItem();
            AddMessage(new JObject
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

            SaveCurrentTaskSnapshot();
        }

        private void AddMessage(JObject message)
        {
            message["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + _messageSequence++;
            var messages = (JArray)_state["clineMessages"];
            messages.Add(message);
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
                IsCompleted = _currentTaskCompleted
            };

            _taskSnapshots[_currentTaskId] = snapshot;
            UpsertHistoryItem(currentTaskItem);
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

            _currentTaskId = taskId;
            _currentTaskCompleted = snapshot.IsCompleted;
            _currentTaskText = snapshot.TaskItem.Value<string>("task") ?? "";
            _pendingAskType = snapshot.IsCompleted ? "resume_completed_task" : "resume_task";
            _state["currentTaskItem"] = snapshot.TaskItem.DeepClone();
            _state["clineMessages"] = snapshot.Messages.DeepClone();
            var resumeAsk = snapshot.IsCompleted ? "resume_completed_task" : "resume_task";
            var lastMessage = ((JArray)_state["clineMessages"]).LastOrDefault() as JObject;
            if (!string.Equals(lastMessage?.Value<string>("ask"), resumeAsk, StringComparison.Ordinal))
            {
                AddMessage(new JObject
                {
                    ["type"] = "ask",
                    ["ask"] = resumeAsk,
                    ["text"] = ""
                });
            }
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

            _apiRequestInProgress = false;
            _currentTaskCompleted = false;
            _currentTaskText = "";
            _pendingAskType = null;
            _currentTaskId = null;
            _state["currentTaskItem"] = null;
            _state["clineMessages"] = new JArray();
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
                    ["enabled"] = settings.AutoApprove,
                    ["favorites"] = new JArray(),
                    ["maxRequests"] = 20,
                    ["actions"] = new JObject
                    {
                        ["readFiles"] = true,
                        ["readFilesExternally"] = false,
                        ["editFiles"] = settings.AutoApprove,
                        ["editFilesExternally"] = false,
                        ["executeSafeCommands"] = settings.AutoApprove,
                        ["executeAllCommands"] = false,
                        ["useBrowser"] = false,
                        ["useMcp"] = false
                    },
                    ["enableNotifications"] = false
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
                ["preferredLanguage"] = "English",
                ["mode"] = "act",
                ["platform"] = "win32",
                ["environment"] = "production",
                ["telemetrySetting"] = "unset",
                ["distinctId"] = "vsclineagent-visualstudio",
                ["planActSeparateModelsSetting"] = true,
                ["enableCheckpointsSetting"] = false,
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
                ["defaultTerminalProfile"] = "default",
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
                ["worktreesEnabled"] = new JObject { ["user"] = false, ["featureFlag"] = false },
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
        }
    }
}
