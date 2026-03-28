"use client";

import React, { useState, useRef, useEffect } from "react";

// Bin Logo 组件 - 使用创始人名字 "Bin"，纯 CSS 圆形徽标，避免 SVG 抗锯齿导致的未完全填充问题
function BinLogo({ size = 24 }) {
  const fontSize = Math.round(size * 0.45);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: "#0F172A",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#FFFFFF",
        fontSize,
        fontWeight: 600,
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        lineHeight: 1
      }}
    >
      Bin
    </div>
  );
}

// 自适应高度的 textarea Hook：根据内容自动调整高度，最多不超过 maxHeight
function useAutoResizeTextArea(value, maxHeight = 220) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
  }, [value, maxHeight]);

  return ref;
}

const STORAGE_KEY_MESSAGES = "maxinfluencer_chat_messages";
const STORAGE_KEY_CONTEXT = "maxinfluencer_chat_context";
const STORAGE_KEY_VERSION = "maxinfluencer_message_version";
const MESSAGE_VERSION = "v2.0"; // 修改 defaultMessage 时更新此版本号

export default function HomePage() {
  // 统一的初始状态（服务端和客户端一致）
  const defaultMessage = [
    {
      role: "assistant",
      name: "Bin",
      content:
        "您好，我是Bin，告诉我您想推广的产品链接，我来帮您发布campaign！"
    }
  ];


  const [messages, setMessages] = useState(defaultMessage);
  // 初始化 context，包含 workflowState
  const [context, setContext] = useState({
    workflowState: "idle", // 初始状态为空闲
  });
  const [mounted, setMounted] = useState(false);
  const [imageErrors, setImageErrors] = useState({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState({}); // 记录哪些消息的思考过程已展开
  const [thinkingMode, setThinkingMode] = useState({}); // 记录每个消息的思考模式：'simple' | 'detailed'
  const isDevelopment = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'); // 开发环境标识
  const messagesEndRef = useRef(null);
  const shouldAutoScrollRef = useRef(true); // 是否应该自动滚动
  const chatContainerRef = useRef(null); // 聊天容器的引用
  const localStorageSaveTimerRef = useRef(null); // localStorage 保存节流定时器（避免流式更新时频繁 JSON.stringify 卡顿）
  const sseDebugRef = useRef({ influencerCount: 0, analyzing: null, lastDetailLen: 0 }); // SSE 调试用（仅本地）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false); // 左侧菜单栏是否收起
  const [middlePanelWidth, setMiddlePanelWidth] = useState(50); // 中间面板宽度百分比（默认50%）
  const isResizingRef = useRef(false); // 是否正在左右调整大小
  const resizeStartXRef = useRef(0); // 开始调整时的鼠标X坐标
  const resizeStartWidthRef = useRef(50); // 开始调整时的中间面板宽度
  const [rightPanelSplit, setRightPanelSplit] = useState(50); // 右侧面板上下区域划分百分比
  const isVerticalResizingRef = useRef(false); // 是否正在上下拖拽
  const verticalResizeStartYRef = useRef(0); // 上下拖拽开始的 Y 坐标
  const verticalResizeStartSplitRef = useRef(50); // 上下拖拽开始时的百分比
  const [executionStatus, setExecutionStatus] = useState(null); // 执行阶段右侧「执行进度」数据
  const [executionLoading, setExecutionLoading] = useState(false);
  const [executionError, setExecutionError] = useState(null);
  const [executionConfig, setExecutionConfig] = useState(null); // 执行阶段右侧「工作笔记」用到的执行节奏 & 汇报配置
  const [executionConfigError, setExecutionConfigError] = useState(null);
  const [activeExecutionStage, setActiveExecutionStage] = useState("pendingPrice"); // 执行进度当前选中的阶段
  const [campaignSessions, setCampaignSessions] = useState([]); // Campaign 草稿列表
  const [publishedSessions, setPublishedSessions] = useState([]); // 已发布 Campaign 列表
  const [currentSessionId, setCurrentSessionId] = useState(null); // 当前会话 ID
  const [loadingSessions, setLoadingSessions] = useState(false); // 加载草稿列表状态
  const [sessionsError, setSessionsError] = useState(null); // 加载草稿列表的错误信息

  // 输入框自适应高度（欢迎页大输入框 + 底部输入框共用同一输入值）
  const inputTextAreaRefMain = useAutoResizeTextArea(input, 220);
  const inputTextAreaRefFooter = useAutoResizeTextArea(input, 220);

  // 加载 Campaign 会话列表（草稿 + 已发布）
  const loadCampaignSessions = async () => {
    try {
      setLoadingSessions(true);
      setSessionsError(null);

      // 1）加载草稿
      const draftResponse = await fetch('/api/sessions?status=draft&limit=50');
      if (!draftResponse.ok) {
        const errorData = await draftResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${draftResponse.status}: ${draftResponse.statusText}`);
      }
      const draftData = await draftResponse.json();

      // 2）加载已发布（出错不影响草稿展示）
      let publishedData = { success: false, sessions: [] };
      try {
        const publishedResponse = await fetch('/api/sessions?status=published&limit=50');
        if (publishedResponse.ok) {
          publishedData = await publishedResponse.json();
        }
      } catch (e) {
        console.warn('[HomePage] 加载已发布会话失败（忽略，仅影响「已发布 Campaign」区块）:', e);
      }

      if (draftData.success) {
        setCampaignSessions(draftData.sessions || []);
        if (publishedData.success) {
          setPublishedSessions(publishedData.sessions || []);
        } else {
          setPublishedSessions([]);
        }
      } else {
        // 如果是表不存在的错误，显示更友好的提示
        if (draftData.code === 'TABLE_NOT_EXISTS') {
          throw new Error('数据库表未创建，请先执行创建表的 SQL');
        }
        throw new Error(draftData.error || '获取草稿列表失败');
      }
    } catch (error) {
      console.error('[HomePage] 加载会话列表失败:', error);
      setSessionsError(error.message || '加载失败，请检查数据库连接');
      // 即使失败也设置空数组，避免显示错误时还显示"暂无草稿"
      setCampaignSessions([]);
      setPublishedSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  };

  // 客户端挂载后从 localStorage 恢复数据，并加载草稿列表
  useEffect(() => {
    setMounted(true);
    
    // 加载草稿列表
    loadCampaignSessions();
    
    if (typeof window !== "undefined") {
      const savedVersion = localStorage.getItem(STORAGE_KEY_VERSION);
      
      // 如果版本不匹配，清除旧数据并使用新的 defaultMessage
      if (savedVersion !== MESSAGE_VERSION) {
        console.log(`[HomePage] 消息版本不匹配 (${savedVersion} → ${MESSAGE_VERSION})，清除旧数据`);
        try {
          localStorage.removeItem(STORAGE_KEY_MESSAGES);
          localStorage.removeItem(STORAGE_KEY_CONTEXT);
          localStorage.setItem(STORAGE_KEY_VERSION, MESSAGE_VERSION);
        } catch (error) {
          console.error('[HomePage] 清除 localStorage 失败:', error);
        }
        setMessages(defaultMessage);
        setContext({});
        return;
      }
      
      // 恢复消息（带错误处理）
      try {
        const savedMessages = localStorage.getItem(STORAGE_KEY_MESSAGES);
        if (savedMessages) {
          try {
            const parsed = JSON.parse(savedMessages);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setMessages(parsed);
            }
          } catch (e) {
            console.error("[HomePage] 恢复消息失败:", e);
            // 如果解析失败，清除损坏的数据
            try {
              localStorage.removeItem(STORAGE_KEY_MESSAGES);
            } catch (clearError) {
              console.error("[HomePage] 清除损坏的消息数据失败:", clearError);
            }
          }
        }
      } catch (error) {
        console.error("[HomePage] 读取消息数据失败:", error);
      }

      // 恢复上下文（带错误处理）
      try {
        const savedContext = localStorage.getItem(STORAGE_KEY_CONTEXT);
        if (savedContext) {
          try {
            const parsed = JSON.parse(savedContext);
            if (parsed && typeof parsed === "object") {
              // 确保 workflowState 存在，如果不存在则设置为 "idle"
              if (!parsed.workflowState) {
                parsed.workflowState = "idle";
              }
              setContext(parsed);
            }
          } catch (e) {
            console.error("[HomePage] 恢复上下文失败:", e);
            // 如果解析失败，清除损坏的数据
            try {
              localStorage.removeItem(STORAGE_KEY_CONTEXT);
            } catch (clearError) {
              console.error("[HomePage] 清除损坏的上下文数据失败:", clearError);
            }
          }
        }
      } catch (error) {
        console.error("[HomePage] 读取上下文数据失败:", error);
      }
    }
  }, []);

  // 保存当前会话到后端（如果存在 currentSessionId）
  // options.reloadSessions: 是否在保存成功后刷新左侧会话列表（默认 true）
  const saveCurrentSession = React.useCallback(async (options = { reloadSessions: true }) => {
    if (!currentSessionId) return;
    
    try {
      // 生成标题（从第一条用户消息提取，或使用默认标题）
      let title = '';
      const firstUserMessage = messages.find(m => m.role === 'user');
      if (firstUserMessage && firstUserMessage.content) {
        title = firstUserMessage.content.slice(0, 50);
      } else {
        title = '新 Campaign';
      }
      
      const response = await fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          messages: messages.slice(-50), // 只保存最近 50 条
          context,
        }),
      });
      
      const data = await response.json();
      if (data.success && options.reloadSessions !== false) {
        // 更新本地草稿列表（可选，避免在仅切换会话时造成左侧闪烁）
        await loadCampaignSessions();
      }
    } catch (error) {
      console.error('[HomePage] 保存会话失败:', error);
    }
  }, [currentSessionId, messages, context, loadCampaignSessions]);

  // 保存消息到 localStorage（带错误处理和存储限制）
  useEffect(() => {
    if (typeof window === "undefined" || !mounted) return;

    // 先清掉上一次的定时器（messages 变化频率高，避免堆积）
    if (localStorageSaveTimerRef.current) {
      clearTimeout(localStorageSaveTimerRef.current);
      localStorageSaveTimerRef.current = null;
    }

    // 流式输出期间 messages 变化频率极高，频繁 JSON.stringify 会造成 UI 卡顿/看起来“流式中断”
    // 这里直接跳过，等 complete 后（loading=false）再保存一次即可
    if (loading) return;

    // 节流：合并短时间内的多次更新
    localStorageSaveTimerRef.current = setTimeout(() => {
      try {
        // 限制存储的消息数量（只保存最近的 50 条消息）
        const messagesToSave = messages.slice(-50);
        
        // 清理消息中的大对象（截图等），避免超出配额
        const cleanedMessages = messagesToSave.map(msg => {
          const cleaned = { ...msg };
          // 移除截图数据（太大，不需要持久化）
          if (cleaned.thinking?.screenshots) {
            cleaned.thinking = {
              ...cleaned.thinking,
              screenshots: [] // 不保存截图到 localStorage
            };
          }
          // 移除 browserSteps（流式分析文本会非常大；真正的持久化依赖后端 session）
          if (cleaned.thinking?.browserSteps) {
            cleaned.thinking = {
              ...cleaned.thinking,
              browserSteps: []
            };
          }
          return cleaned;
        });
        
        const messagesJson = JSON.stringify(cleanedMessages);
        
        // 检查数据大小（localStorage 限制通常是 5-10MB）
        if (messagesJson.length > 4 * 1024 * 1024) { // 4MB 限制
          console.warn('[HomePage] 消息数据过大，只保存最近的 30 条消息');
          const limitedMessages = cleanedMessages.slice(-30);
          localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(limitedMessages));
        } else {
          localStorage.setItem(STORAGE_KEY_MESSAGES, messagesJson);
        }
      } catch (error) {
        if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
          console.warn('[HomePage] localStorage 配额已满，尝试清理并只保存最近的 20 条消息');
          try {
            // 尝试清理并只保存最近的消息，移除所有截图以节省空间
            const limitedMessages = messages.slice(-20).map(msg => {
              const cleaned = { ...msg };
              if (cleaned.thinking?.screenshots) {
                cleaned.thinking = { ...cleaned.thinking, screenshots: [] };
              }
              return cleaned;
            });
            localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(limitedMessages));
          } catch (retryError) {
            console.error('[HomePage] 无法保存消息到 localStorage:', retryError);
            // 如果还是失败，清除所有数据并重新开始
            try {
              localStorage.removeItem(STORAGE_KEY_MESSAGES);
              localStorage.removeItem(STORAGE_KEY_CONTEXT);
            } catch (clearError) {
              console.error('[HomePage] 无法清除 localStorage:', clearError);
            }
          }
        } else {
          console.error('[HomePage] 保存消息到 localStorage 失败:', error);
        }
      }
    }, 400);

    return () => {
      if (localStorageSaveTimerRef.current) {
        clearTimeout(localStorageSaveTimerRef.current);
        localStorageSaveTimerRef.current = null;
      }
    };
  }, [messages, mounted, loading]);

  // 保存上下文到 localStorage（带错误处理）
  useEffect(() => {
    if (typeof window !== "undefined" && mounted) {
      try {
        const contextJson = JSON.stringify(context);
        localStorage.setItem(STORAGE_KEY_CONTEXT, contextJson);
      } catch (error) {
        if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
          console.warn('[HomePage] localStorage 配额已满，无法保存上下文');
          // 尝试清除旧数据
          try {
            localStorage.removeItem(STORAGE_KEY_CONTEXT);
          } catch (clearError) {
            console.error('[HomePage] 无法清除上下文数据:', clearError);
          }
        } else {
          console.error('[HomePage] 保存上下文到 localStorage 失败:', error);
        }
      }
    }
  }, [context, mounted]);

  // 在「执行阶段」（已发布）加载执行进度数据
  useEffect(() => {
    const campaignId = context?.campaignId;
    const isExecutionPhase =
      context?.workflowState === "published" || context?.published === true;

    if (!campaignId || !isExecutionPhase) {
      // 非执行阶段或没有 campaignId 时，清空执行进度状态
      setExecutionStatus(null);
      setExecutionError(null);
      setExecutionLoading(false);
      return;
    }

    let cancelled = false;

    const loadExecutionStatus = async () => {
      try {
        setExecutionLoading(true);
        setExecutionError(null);
        const res = await fetch(`/api/campaigns/${campaignId}/execution-status`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          if (data.success) {
            setExecutionStatus(data);
          } else {
            setExecutionError(data.error || "获取执行进度失败");
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[HomePage] 获取执行进度失败:", e);
          setExecutionError(e.message || "获取执行进度失败");
        }
      } finally {
        if (!cancelled) {
          setExecutionLoading(false);
        }
      }
    };

    loadExecutionStatus();

    return () => {
      cancelled = true;
    };
  }, [context?.campaignId, context?.workflowState, context?.published]);

  // 在「执行阶段」加载执行节奏 & 汇报配置（用于工作笔记）
  useEffect(() => {
    const campaignId = context?.campaignId;
    const isExecutionPhase =
      context?.workflowState === "published" || context?.published === true;

    if (!campaignId || !isExecutionPhase) {
      setExecutionConfig(null);
      setExecutionConfigError(null);
      return;
    }

    let cancelled = false;

    const loadReportConfig = async () => {
      try {
        setExecutionConfigError(null);
        const res = await fetch(`/api/campaigns/${campaignId}/report-config`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          if (data.success) {
            setExecutionConfig(data);
          } else {
            setExecutionConfigError(data.error || "获取执行配置失败");
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[HomePage] 获取执行配置失败:", e);
          setExecutionConfigError(e.message || "获取执行配置失败");
        }
      }
    };

    loadReportConfig();

    return () => {
      cancelled = true;
    };
  }, [context?.campaignId, context?.workflowState, context?.published]);

  // 智能自动滚动：只在用户发送消息或AI开始新回复时滚动，不在步骤更新时滚动
  useEffect(() => {
    // 只在应该自动滚动时执行
    if (shouldAutoScrollRef.current && messagesEndRef.current) {
      // 检查用户是否手动滚动到了顶部（查看历史消息）
      if (chatContainerRef.current) {
        const container = chatContainerRef.current;
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200; // 距离底部200px内
        // 如果用户不在底部附近，说明在查看历史消息，不自动滚动
        if (!isNearBottom) {
          return;
        }
      }
      // 延迟一点执行滚动，确保DOM已更新
      setTimeout(() => {
        if (messagesEndRef.current && shouldAutoScrollRef.current) {
          messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
      }, 50);
    }
  }, [messages]);

  async function handleSend(e) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    // 用户发送消息时，启用自动滚动
    shouldAutoScrollRef.current = true;

    const userMessage = {
      role: "user",
      content: input.trim()
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    // 创建助手消息占位符，用于实时更新
    const assistantMessageIndex = nextMessages.length;
    const initialAssistantMessage = {
      role: "assistant",
      name: "Bin",
      content: "",
      thinking: {
        steps: [],
        currentState: context.workflowState || "idle",
        nextState: null,
        toolCall: null,
        subAgentResult: null,
        browserSteps: [], // 初始化浏览器步骤
        screenshots: [], // 初始化截图
      },
      isThinkingExpanded: true // 默认展开思考过程（Cursor 风格）
    };
    setMessages([...nextMessages, initialAssistantMessage]);

    try {
      // 如果还没有会话 ID，创建新会话
      if (!currentSessionId) {
        try {
          const title = input.trim().slice(0, 50) || '新 Campaign';
          const createRes = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              messages: nextMessages,
              context,
              status: 'draft',
            }),
          });
          const createData = await createRes.json();
          if (createData.success) {
            setCurrentSessionId(createData.session.id);
            await loadCampaignSessions();
          }
        } catch (error) {
          console.error('[HomePage] 创建会话失败:', error);
        }
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: nextMessages,
          context: context, // 传递当前上下文
          stream: true // 启用流式传输
        })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "请求失败");
      }

      // 检查是否是流式响应
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.includes("text/event-stream")) {
        // 流式接收数据
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || ""; // 保留最后一个不完整的行

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                
                if (data.type === "thinking") {
                  // 本地调试日志：观察流式分析是否持续推进、累计了几位红人
                  if (isDevelopment) {
                    try {
                      const currentCount = Array.isArray(data.data?.influencerAnalyses) ? data.data.influencerAnalyses.length : 0;
                      if (currentCount !== sseDebugRef.current.influencerCount) {
                        console.log(`[SSE] influencerAnalyses 累计更新: ${sseDebugRef.current.influencerCount} → ${currentCount}`);
                        sseDebugRef.current.influencerCount = currentCount;
                      }
                      const steps = Array.isArray(data.data?.browserSteps) ? data.data.browserSteps : [];
                      const analyzeStep = steps.find(s => s && s.id === 'analyze_match');
                      const analyzing = analyzeStep?.stats?.analyzing || null;
                      if (analyzing && analyzing !== sseDebugRef.current.analyzing) {
                        console.log(`[SSE] 开始/切换分析对象: @${analyzing}`);
                        sseDebugRef.current.analyzing = analyzing;
                        sseDebugRef.current.lastDetailLen = 0;
                      }
                      const detailLen = typeof analyzeStep?.detail === 'string' ? analyzeStep.detail.length : 0;
                      if (detailLen - sseDebugRef.current.lastDetailLen >= 800) {
                        console.log(`[SSE] analyze_match.detail 增长: ${sseDebugRef.current.lastDetailLen} → ${detailLen}`);
                        sseDebugRef.current.lastDetailLen = detailLen;
                      }
                    } catch (e) {
                      // ignore
                    }
                  }
                  // 更新思考过程（合并数据，保留 browserSteps、screenshots、influencerAnalyses）
                  setMessages(prev => {
                    const updated = [...prev];
                    if (updated[assistantMessageIndex]) {
                      const currentThinking = updated[assistantMessageIndex].thinking || {};
                      const newThinking = {
                        ...currentThinking,
                        ...data.data,
                        browserSteps: data.data.browserSteps !== undefined 
                          ? data.data.browserSteps 
                          : (currentThinking.browserSteps || []),
                        screenshots: data.data.screenshots !== undefined 
                          ? data.data.screenshots 
                          : (currentThinking.screenshots || []),
                        influencerAnalyses: data.data.influencerAnalyses !== undefined 
                          ? data.data.influencerAnalyses 
                          : (currentThinking.influencerAnalyses || []),
                      };
                      
                      if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
                        if (data.data.influencerAnalyses?.length) {
                          console.log('[前端] 收到红人分析卡片更新:', data.data.influencerAnalyses.length);
                        }
                      }
                      
                      updated[assistantMessageIndex] = {
                        ...updated[assistantMessageIndex],
                        thinking: newThinking
                      };
                    }
                    return updated;
                  });
                } else if (data.type === "complete") {
                  // 最终结果（合并 thinking，保留 browserSteps、screenshots、influencerAnalyses）
                  setMessages(prev => {
                    const updated = [...prev];
                    if (updated[assistantMessageIndex]) {
                      const currentThinking = updated[assistantMessageIndex].thinking || {};
                      const finalThinking = data.data.thinking || {};
                      updated[assistantMessageIndex] = {
                        ...updated[assistantMessageIndex],
                        content: data.data.reply,
                        thinking: {
                          ...currentThinking,
                          ...finalThinking,
                          browserSteps: finalThinking.browserSteps || currentThinking.browserSteps || [],
                          screenshots: finalThinking.screenshots || currentThinking.screenshots || [],
                          influencerAnalyses: finalThinking.influencerAnalyses || currentThinking.influencerAnalyses || [],
                        }
                      };
                    }
                    return updated;
                  });

                  // 更新上下文
                  if (data.data.context) {
                    setContext(data.data.context);
                  }

                  // 消息发送完成后，更新会话（延迟保存，避免频繁请求）
                  if (currentSessionId) {
                    setTimeout(() => {
                      saveCurrentSession();
                    }, 1000);
                  }
                } else if (data.type === "error") {
                  throw new Error(data.data.error);
                }
              } catch (parseError) {
                console.error("解析SSE数据失败:", parseError);
              }
            }
          }
        }
      } else {
        // 非流式响应（兼容旧版本）
        const data = await res.json();

        if (data && data.reply) {
          setMessages(prev => {
            const updated = [...prev];
            if (updated[assistantMessageIndex]) {
              updated[assistantMessageIndex] = {
                ...updated[assistantMessageIndex],
                content: data.reply,
                thinking: data.thinking
              };
            }
            return updated;
          });

          if (data.context) {
            setContext(data.context);
          }
        }
      }
    } catch (err) {
      console.error('[HomePage] 请求失败:', err);
      
      // 检查是否是网络错误或连接错误（可能是刷新页面导致的）
      const isNetworkError = err.name === 'TypeError' && 
                            (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('Failed to fetch'));
      
      // 检查消息是否已经有内容（可能是从 localStorage 恢复的）
      const currentMessage = messages[assistantMessageIndex];
      const hasContent = currentMessage?.content || 
                        (currentMessage?.thinking?.steps?.length > 0) ||
                        (currentMessage?.thinking?.browserSteps?.length > 0);
      
      // 如果是网络错误且消息已有内容，可能是刷新导致的，不显示错误
      if (isNetworkError && hasContent) {
        console.log('[HomePage] 检测到网络错误，但消息已有内容（可能是刷新页面），不显示错误');
        setLoading(false);
        return;
      }
      
      // 其他情况显示错误
      setMessages(prev => {
        const updated = [...prev];
        if (updated[assistantMessageIndex]) {
          // 检查是否已经有内容，如果有则不覆盖
          const msgHasContent = updated[assistantMessageIndex].content || 
                                (updated[assistantMessageIndex].thinking?.steps?.length > 0);
          
          if (!msgHasContent) {
            // 只有完全没有内容时才显示错误
            updated[assistantMessageIndex] = {
              ...updated[assistantMessageIndex],
              content: `抱歉，服务暂时出现问题：${err.message}。请稍后再试。`
            };
          }
        }
        return updated;
      });
    } finally {
      setLoading(false);
    }
  }

  // 获取状态描述
  const getStateDescription = (state) => {
    if (!state) return "未知状态";
    const stateMap = {
      "idle": "空闲状态",
      "step_1_product_info": "步骤 1 - 确认产品信息",
      "step_2_campaign_info": "步骤 2 - 确认 Campaign 信息",
      "step_3_influencer_profile": "步骤 3 - 确认红人画像",
      "step_4_content_requirement": "步骤 4 - 确认内容要求",
      "step_5_publish_confirm": "步骤 5 - 确认发布",
    };
    return stateMap[state] || state;
  };

  // 计算进度
  const calculateProgress = (currentState) => {
    const stateOrder = ["idle", "step_1_product_info", "step_2_campaign_info", "step_3_influencer_profile", "step_4_content_requirement", "step_5_publish_confirm"];
    const currentIndex = stateOrder.indexOf(currentState);
    if (currentIndex === -1 || currentIndex === 0) return { current: 0, total: 5, percentage: 0 };
    const total = stateOrder.length - 1; // 排除 idle
    return {
      current: currentIndex,
      total: total,
      percentage: Math.round((currentIndex / total) * 100)
    };
  };

  // 获取步骤状态（已完成/进行中/待执行）
  const getStepStatus = (stepIndex, totalSteps, isComplete) => {
    // 如果已经完成（有最终回复），所有步骤都是已完成
    if (isComplete) {
      return 'completed';
    }
    // 最后一步是进行中，之前的步骤是已完成
    if (stepIndex === totalSteps - 1) {
      return 'running';
    }
    return 'completed';
  };

  // 术语映射：将技术术语转换为业务语言
  const translateToBusinessLanguage = (agent, action, result) => {
    const mapping = {
      "BinAgent-意图识别": {
        icon: "🔍",
        title: "分析需求",
        description: (result) => {
          if (result?.needTool) {
            const toolNames = {
              'product_info_agent': '提取产品信息',
              'campaign_info_agent': '收集投放信息',
              'influencer_profile_agent': '推荐红人',
              'content_requirement_agent': '生成内容脚本',
              'campaign_publish_agent': '汇总并确认发布'
            };
            return `已识别：需要${toolNames[result.toolName] || '处理'}`;
          }
          return "正在理解您的需求...";
        }
      },
      "AgentRouter-路由决策": {
        icon: "🔄",
        title: "处理中",
        description: (result) => {
          if (typeof result === 'string' && result.includes('product_info_agent')) return "准备提取产品信息...";
          if (typeof result === 'string' && result.includes('campaign_info_agent')) return "准备收集投放信息...";
          return "正在处理...";
        }
      },
      "ProductInfoAgent-提取产品信息": {
        icon: "📦",
        title: "提取产品信息",
        description: "正在从产品链接提取信息..."
      },
      "ProductInfoAgent-确认产品信息": {
        icon: "✅",
        title: "确认产品信息",
        description: "正在检测您是否确认产品信息..."
      },
      "CampaignInfoAgent-收集Campaign信息": {
        icon: "📊",
        title: "收集投放信息",
        description: "正在从您的消息中提取投放信息..."
      },
      "InfluencerProfileAgent-推荐红人画像和账户": {
        icon: "👥",
        title: "推荐红人",
        description: "正在基于产品信息和投放信息推荐合适的红人..."
      },
      "ContentRequirementAgent-生成内容脚本": {
        icon: "✍️",
        title: "生成内容脚本",
        description: "正在生成内容脚本要求和参考视频..."
      },
      "CampaignPublishAgent-汇总并确认发布": {
        icon: "📋",
        title: "汇总信息",
        description: "正在汇总所有信息并确认发布..."
      },
      "AgentRouter-状态更新": {
        icon: "➡️",
        title: "步骤完成",
        description: (result) => result || "进入下一步"
      },
      "AgentRouter-状态自动更新": {
        icon: "➡️",
        title: "自动推进",
        description: (result) => result || "状态自动更新"
      },
      "AgentRouter-引导消息": {
        icon: "💡",
        title: "引导提示",
        description: "检测到引导消息，保持当前状态"
      },
      "BinAgent-直接回复": {
        icon: "💬",
        title: "直接回复",
        description: "无需调用工具，直接回复您"
      }
    };

    const key = `${agent}-${action}`;
    const mapped = mapping[key];
    
    if (mapped) {
      return {
        ...mapped,
        description: typeof mapped.description === 'function' 
          ? mapped.description(result) 
          : mapped.description
      };
    }

    // 默认返回
    return {
      icon: "⚙️",
      title: action,
      description: typeof result === 'string' ? result : "处理中..."
    };
  };

  // 渲染消息内容，支持图片显示
  function renderMessageContent(content) {
    if (!content) return content;
    
    // 同时匹配图片标记 [IMAGE:url]、Markdown 链接 [text](url) 和红人账户标记 [INFLUENCER:...]
    const imageRegex = /\[IMAGE:(.+?)\]/g;
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    // 使用更宽松的正则，允许空值和特殊字符，使用非贪婪匹配
    // 格式: [INFLUENCER:avatar:url:platform:id:name:followers:views:reason:isRecommended:analysis]
    const influencerRegex = /\[INFLUENCER:([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^\]]*?)\]/g;
    const parts = [];
    let lastIndex = 0;
    let partIndex = 0;
    
    // 收集所有匹配项（图片、链接和红人账户）
    const matches = [];
    
    // 匹配图片
    let match;
    while ((match = imageRegex.exec(content)) !== null) {
      matches.push({
        type: 'image',
        index: match.index,
        length: match[0].length,
        url: match[1],
        fullMatch: match[0]
      });
    }
    
    // 匹配链接
    linkRegex.lastIndex = 0; // 重置正则
    while ((match = linkRegex.exec(content)) !== null) {
      matches.push({
        type: 'link',
        index: match.index,
        length: match[0].length,
        text: match[1],
        url: match[2],
        fullMatch: match[0]
      });
    }
    
    // 匹配红人账户
    influencerRegex.lastIndex = 0; // 重置正则
    while ((match = influencerRegex.exec(content)) !== null) {
      matches.push({
        type: 'influencer',
        index: match.index,
        length: match[0].length,
        avatar: match[1],
        profileUrl: match[2],
        platform: match[3],
        id: match[4],
        name: match[5],
        followers: match[6],
        views: match[7],
        reason: match[8],
        isRecommended: match[9] === '1' ? true : (match[9] === '0' ? false : null),
        analysis: match[10] ? match[10].replace(/；/g, ':') : null, // 恢复冒号
        fullMatch: match[0]
      });
    }
    
    // 按索引排序
    matches.sort((a, b) => a.index - b.index);
    
    // 分离influencer匹配和其他匹配
    const influencerMatches = matches.filter(m => m.type === 'influencer');
    const otherMatches = matches.filter(m => m.type !== 'influencer');
    
    // 先处理非influencer的匹配
    for (const match of otherMatches) {
      // 添加匹配前的文本
      if (match.index > lastIndex) {
        const text = content.substring(lastIndex, match.index);
        if (text) {
          parts.push(
            <span key={`text-${partIndex++}`}>{text}</span>
          );
        }
      }
      
      if (match.type === 'image') {
        // 处理图片
        const imageUrl = match.url;
        const imageKey = `img-${partIndex++}`;
        const hasError = imageErrors[imageUrl];
        
        parts.push(
          <div
            key={`img-wrapper-${imageKey}`}
            style={{
              marginTop: 12,
              marginBottom: 12,
              display: "flex",
              justifyContent: "center",
              flexDirection: "column",
              alignItems: "center"
            }}
          >
            {!hasError ? (
              <img
                key={imageKey}
                src={imageUrl}
                alt="红人头像"
                loading="lazy"
                style={{
                  maxWidth: "100%",
                  maxHeight: "700px",
                  borderRadius: 12,
                  display: "block",
                  objectFit: "contain",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                  backgroundColor: "rgba(255,255,255,0.05)"
                }}
                onError={(e) => {
                  const img = e.target;
                  const failedUrl = img.src;
                  
                  console.error(`[Image] 图片加载失败:`, {
                    url: failedUrl,
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                    complete: img.complete
                  });
                  
                  if (failedUrl.startsWith("http://") && !failedUrl.startsWith("https://")) {
                    const httpsUrl = failedUrl.replace("http://", "https://");
                    console.log(`[Image] 尝试使用 HTTPS 版本: ${httpsUrl}`);
                    img.src = httpsUrl;
                    return;
                  }
                  
                  setImageErrors(prev => ({ ...prev, [failedUrl]: true }));
                }}
                onLoad={() => {
                  console.log("图片加载成功:", imageUrl);
                }}
              />
            ) : (
              <div
                style={{
                  color: "#6B7280",
                  fontSize: 12,
                  padding: "8px 12px",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4
                }}
              >
                <div>图片加载失败</div>
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "#3B82F6",
                    fontSize: 11,
                    textDecoration: "underline",
                    cursor: "pointer"
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  在新窗口打开
                </a>
              </div>
            )}
          </div>
        );
      } else if (match.type === 'link') {
        // 处理链接
        parts.push(
          <a
            key={`link-${partIndex++}`}
            href={match.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "#3B82F6",
              textDecoration: "underline",
              cursor: "pointer",
              fontWeight: 500
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {match.text}
          </a>
        );
      }
      
      lastIndex = match.index + match.length;
    }
    
    // 单独处理influencer匹配 - 渲染为表格形式
    if (influencerMatches.length > 0) {
      // 找到第一个influencer匹配前的文本
      const firstInfluencerIndex = influencerMatches[0].index;
      if (firstInfluencerIndex > lastIndex) {
        const text = content.substring(lastIndex, firstInfluencerIndex);
        if (text) {
          parts.push(
            <span key={`text-${partIndex++}`}>{text}</span>
          );
        }
      }
      
      // 平台图标组件
      const TikTokIcon = () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
          <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
        </svg>
      );
      
      const InstagramIcon = () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
          <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
        </svg>
      );
      
      // 渲染表格容器
      parts.push(
        <div
          key={`influencer-table-${partIndex++}`}
          style={{
            marginTop: 16,
            marginBottom: 16,
            backgroundColor: "#FFFFFF",
            borderRadius: 12,
            border: "1px solid #E5E7EB",
            overflow: "hidden",
            boxShadow: "0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)"
          }}
        >
          {/* 表头行 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "60px 1fr 120px 120px 1fr",
              gap: 16,
              padding: "12px 16px",
              backgroundColor: "#F3F4F6",
              borderBottom: "1px solid #E5E7EB",
              alignItems: "center",
              fontSize: 13,
              fontWeight: 600,
              color: "#1F2937"
            }}
          >
            <div></div> {/* 头像列 */}
            <div>用户名</div>
            <div>粉丝量</div>
            <div>播放量</div>
            <div>是否推荐</div>
            <div>推荐理由</div>
          </div>
          
          {/* 数据行 */}
          {influencerMatches.map((match, idx) => {
            const avatarUrl = match.avatar;
            const hasAvatarError = avatarUrl && imageErrors[avatarUrl];
            const platform = match.platform || 'TikTok';
            
            return (
              <div
                key={`influencer-row-${idx}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "60px 1fr 120px 120px 100px 1fr",
                  gap: 16,
                  padding: "12px 16px",
                  borderBottom: idx < influencerMatches.length - 1 ? "1px solid #E5E7EB" : "none",
                  alignItems: "center",
                  fontSize: 13,
                  backgroundColor: match.isRecommended === true ? "#F0FDF4" : (match.isRecommended === false ? "#FEF2F2" : "#FFFFFF")
                }}
              >
                {/* 头像 */}
                <div style={{ flexShrink: 0 }}>
                  {avatarUrl && !hasAvatarError ? (
                    <img
                      src={avatarUrl}
                      alt={match.name || match.id}
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: "50%",
                        objectFit: "cover",
                        border: "2px solid #E5E7EB"
                      }}
                      onError={(e) => {
                        const failedUrl = e.target.src;
                        if (failedUrl.startsWith("http://") && !failedUrl.startsWith("https://")) {
                          e.target.src = failedUrl.replace("http://", "https://");
                          return;
                        }
                        setImageErrors(prev => ({ ...prev, [failedUrl]: true }));
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: "50%",
                        backgroundColor: "#F3F4F6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#6B7280",
                        fontSize: 18
                      }}
                    >
                      {match.name ? match.name.charAt(0).toUpperCase() : "?"}
                    </div>
                  )}
                </div>
                
                {/* 用户名（可点击，带平台图标） */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <div style={{ 
                    color: platform === 'TikTok' ? 'rgba(255,0,80,0.9)' : 'rgba(225,48,108,0.9)',
                    display: "flex",
                    alignItems: "center"
                  }}>
                    {platform === 'TikTok' ? <TikTokIcon /> : <InstagramIcon />}
                  </div>
                  <a
                    href={match.profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: "#3B82F6",
                      textDecoration: "none",
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis"
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={(e) => {
                      e.target.style.textDecoration = "underline";
                    }}
                    onMouseLeave={(e) => {
                      e.target.style.textDecoration = "none";
                    }}
                  >
                    {match.name || match.id}
                  </a>
                </div>
                
                {/* 粉丝量 */}
                <div style={{ color: "#1F2937" }}>
                  {match.followers}
                </div>
                
                {/* 播放量 */}
                <div style={{ color: "#1F2937" }}>
                  {match.views}
                </div>
                
                {/* 是否推荐 */}
                <div style={{ 
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}>
                  {match.isRecommended === true ? (
                    <span style={{
                      padding: "4px 8px",
                      borderRadius: 4,
                      backgroundColor: "#10B981",
                      color: "#FFFFFF",
                      fontSize: 11,
                      fontWeight: 600
                    }}>
                      ✓ 推荐
                    </span>
                  ) : match.isRecommended === false ? (
                    <span style={{
                      padding: "4px 8px",
                      borderRadius: 4,
                      backgroundColor: "#EF4444",
                      color: "#FFFFFF",
                      fontSize: 11,
                      fontWeight: 600
                    }}>
                      ✗ 不推荐
                    </span>
                  ) : (
                    <span style={{
                      padding: "4px 8px",
                      borderRadius: 4,
                      backgroundColor: "#9CA3AF",
                      color: "#FFFFFF",
                      fontSize: 11,
                      fontWeight: 600
                    }}>
                      ? 未分析
                    </span>
                  )}
                </div>
                
                {/* 推荐理由 */}
                <div style={{ 
                  color: "#6B7280", 
                  lineHeight: 1.4,
                  minWidth: 0
                }}>
                  {match.reason}
                  {match.analysis && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ 
                        cursor: "pointer", 
                        color: "#3B82F6",
                        fontSize: 11
                      }}>
                        查看详细分析
                      </summary>
                      <div style={{ 
                        marginTop: 8,
                        padding: 8,
                        backgroundColor: "#F9FAFB",
                        borderRadius: 4,
                        fontSize: 11,
                        color: "#4B5563",
                        whiteSpace: "pre-wrap"
                      }}>
                        {match.analysis}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      );
      
      // 更新lastIndex到最后一个influencer匹配之后
      const lastInfluencerMatch = influencerMatches[influencerMatches.length - 1];
      lastIndex = lastInfluencerMatch.index + lastInfluencerMatch.length;
    }
    
    // 添加剩余文本
    if (lastIndex < content.length) {
      const remainingText = content.substring(lastIndex);
      if (remainingText) {
        parts.push(
          <span key={`text-${partIndex++}`}>{remainingText}</span>
        );
      }
    }
    
    // 如果没有匹配项，直接返回原文本
    if (parts.length === 0) {
      return content;
    }
    
    // 返回 React Fragment
    return <>{parts}</>;
  }

  // 清除对话和上下文（可选功能）
  function handleClear() {
    if (typeof window !== "undefined" && confirm("确定要清除所有对话记录吗？")) {
      setMessages(defaultMessage);
      setContext({ workflowState: "idle" }); // 重置为初始状态
      setImageErrors({});
      localStorage.removeItem(STORAGE_KEY_MESSAGES);
      localStorage.removeItem(STORAGE_KEY_CONTEXT);
    }
  }

  // 判断是否为空状态：未选中任何会话且只有初始欢迎消息时显示欢迎页；选中了草稿/已发布会话则始终显示对话+执行界面
  const isEmptyState =
    !currentSessionId &&
    messages.length === 1 &&
    messages[0].role === "assistant" &&
    messages[0].name === "Bin";

  // 发布 Campaign：仅返回首页，新建对话，不改变任何会话的草稿 / 已发布状态
  const handleCreateNewSession = async () => {
    try {
      // 如果当前有会话且不是空状态，仅保存为草稿，不修改 status
      if (currentSessionId && !isEmptyState) {
        await saveCurrentSession();
      }

      // 回到首页空对话状态：当前编辑的会话仍然是草稿，已发布会话保持已发布
      setCurrentSessionId(null);
      setMessages(defaultMessage);
      setContext({ workflowState: 'idle' });
      await loadCampaignSessions();
    } catch (error) {
      console.error('[HomePage] 处理发布 Campaign 点击失败:', error);
    }
  };

  // 切换到指定会话
  const handleSwitchSession = async (sessionId) => {
    try {
      // 先保存当前会话
      if (currentSessionId && currentSessionId !== sessionId) {
        // 切换会话时无需刷新左侧列表，避免视觉闪烁
        await saveCurrentSession({ reloadSessions: false });
      }
      
      // 加载新会话
      const response = await fetch(`/api/sessions/${sessionId}`);
      const data = await response.json();
      if (data.success && data.session) {
        setCurrentSessionId(sessionId);
        setMessages(data.session.messages || defaultMessage);
        setContext(data.session.context || { workflowState: 'idle' });
      }
    } catch (error) {
      console.error('[HomePage] 切换会话失败:', error);
    }
  };

  // 删除会话
  const handleDeleteSession = async (sessionId, e) => {
    e.stopPropagation(); // 阻止触发切换会话
    
    if (!confirm('确定要删除这个草稿吗？')) return;
    
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      
      const data = await response.json();
      if (data.success) {
        // 如果删除的是当前会话，重置为新会话
        if (sessionId === currentSessionId) {
          setCurrentSessionId(null);
          setMessages(defaultMessage);
          setContext({ workflowState: 'idle' });
        }
        await loadCampaignSessions();
      }
    } catch (error) {
      console.error('[HomePage] 删除会话失败:', error);
    }
  };

  // 快捷功能按钮点击处理
  function handleQuickAction(action) {
    let prompt = "";
    switch (action) {
      case "publish":
        // 发布 Campaign = 创建新会话
        handleCreateNewSession();
        return;
      case "modify":
        prompt = "我想修改已发布的campaign";
        break;
      case "speed":
        prompt = "我想调整campaign的执行速度";
        break;
      default:
        return;
    }
    setInput(prompt);
    // 自动聚焦到输入框
    setTimeout(() => {
      const textarea = document.querySelector("textarea");
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(prompt.length, prompt.length);
      }
    }, 100);
  }

  // 处理拖拽调整宽度
  const handleMouseDown = (e) => {
    isResizingRef.current = true;
    resizeStartXRef.current = e.clientX;
    resizeStartWidthRef.current = middlePanelWidth;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    e.preventDefault();
  };

  const handleMouseMove = (e) => {
    if (!isResizingRef.current) return;
    const deltaX = e.clientX - resizeStartXRef.current;
    const containerWidth = window.innerWidth - (sidebarCollapsed ? 60 : 240);
    const deltaPercent = (deltaX / containerWidth) * 100;
    const newWidth = Math.max(30, Math.min(70, resizeStartWidthRef.current + deltaPercent));
    setMiddlePanelWidth(newWidth);
  };

  const handleMouseUp = () => {
    isResizingRef.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };

  // 右侧面板：处理上下拖拽分割
  const handleVerticalMouseDown = (e) => {
    isVerticalResizingRef.current = true;
    verticalResizeStartYRef.current = e.clientY;
    verticalResizeStartSplitRef.current = rightPanelSplit;
    document.addEventListener('mousemove', handleVerticalMouseMove);
    document.addEventListener('mouseup', handleVerticalMouseUp);
    e.preventDefault();
  };

  const handleVerticalMouseMove = (e) => {
    if (!isVerticalResizingRef.current) return;
    const deltaY = e.clientY - verticalResizeStartYRef.current;
    const container = document.getElementById('right-panel-split-container');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const containerHeight = rect.height || 1;
    const deltaPercent = (deltaY / containerHeight) * 100;
    const newSplit = Math.max(20, Math.min(80, verticalResizeStartSplitRef.current + deltaPercent));
    setRightPanelSplit(newSplit);
  };

  const handleVerticalMouseUp = () => {
    isVerticalResizingRef.current = false;
    document.removeEventListener('mousemove', handleVerticalMouseMove);
    document.removeEventListener('mouseup', handleVerticalMouseUp);
  };

  // 清理事件监听器
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousemove', handleVerticalMouseMove);
      document.removeEventListener('mouseup', handleVerticalMouseUp);
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        backgroundColor: "#FFFFFF",
        position: "relative",
        overflow: "hidden",
        paddingLeft: sidebarCollapsed ? 48 : 0, // 收起时预留左侧窄栏空间，避免遮挡聊天内容
      }}
    >
      {/* 收缩状态下的左侧窄栏（仿照 Manus 左栏） */}
      {sidebarCollapsed && (
      <div
        style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: 48,
            backgroundColor: "#F3F4F6",
          borderRight: "1px solid #E5E7EB",
          display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: 16,
            paddingBottom: 16,
            gap: 12,
            zIndex: 30,
          }}
        >
          {/* 视图切换 / 展开按钮 */}
          <button
            type="button"
            onClick={() => setSidebarCollapsed(false)}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: "none",
              backgroundColor: "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <div
              style={{
                width: 18,
                height: 16,
                borderRadius: 4,
                border: "1.5px solid #111827",
                display: "flex",
                flexDirection: "row",
                overflow: "hidden",
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  width: "45%",
                  borderRight: "1.5px solid #111827",
                  backgroundColor: "transparent",
                }}
              />
              <div style={{ flex: 1 }} />
            </div>
          </button>

          {/* 新建 Campaign 按钮：圆形加号图标 */}
          <button
            type="button"
            onClick={() => handleQuickAction("publish")}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: "none",
              backgroundColor: "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                border: "1.5px solid #111827",
                position: "relative",
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  width: 8,
                  height: 1.5,
                  backgroundColor: "#111827",
                  transform: "translate(-50%, -50%)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  width: 1.5,
                  height: 8,
                  backgroundColor: "#111827",
                  transform: "translate(-50%, -50%)",
                }}
              />
            </div>
          </button>
        </div>
      )}
      {/* 左侧菜单栏 */}
      <div
        style={{
          width: sidebarCollapsed ? 0 : 240,
          backgroundColor: "#F9FAFB",
          borderRight: sidebarCollapsed ? "none" : "1px solid #E5E7EB",
          display: sidebarCollapsed ? "none" : "flex",
          flexDirection: "column",
          transition: "width 0.3s ease",
          flexShrink: 0
        }}
      >
        {/* Logo、视图切换与新建按钮 */}
        <div
          style={{
            padding: "16px",
            borderBottom: "1px solid #E5E7EB",
            display: "flex",
            alignItems: "center",
            justifyContent: sidebarCollapsed ? "center" : "space-between"
          }}
        >
          {!sidebarCollapsed && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <BinLogo size={24} />
              </div>
              <div style={{ fontWeight: 600, color: "#1F2937", fontSize: 14 }}>
                Maxin AI
              </div>
            </div>
          )}

          {sidebarCollapsed ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                padding: 2,
                borderRadius: 999,
                backgroundColor: "#F3F4F6",
                border: "1px solid #E5E7EB",
              }}
            >
              {/* 视图切换 / 展开按钮：仿照左侧布局图标 */}
          <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                style={{
                  width: 28,
                  height: 20,
                  borderRadius: 999,
                  border: "none",
                  backgroundColor: "#FFFFFF",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 12,
                    borderRadius: 4,
                    border: "1.5px solid #111827",
                    display: "flex",
                    flexDirection: "row",
                    overflow: "hidden",
                    boxSizing: "border-box",
                  }}
                >
                  <div
                    style={{
                      width: "45%",
                      borderRight: "1.5px solid #111827",
                      backgroundColor: "transparent",
                    }}
                  />
                  <div style={{ flex: 1 }} />
                </div>
              </button>

              {/* 新建 Campaign 按钮：圆形加号图标 */}
              <button
                type="button"
                onClick={() => handleQuickAction("publish")}
                style={{
                  width: 28,
                  height: 20,
                  borderRadius: 999,
                  border: "none",
                  backgroundColor: "#FFFFFF",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: "1.5px solid #111827",
                    position: "relative",
                    boxSizing: "border-box",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      width: 7,
                      height: 1.5,
                      backgroundColor: "#111827",
                      transform: "translate(-50%, -50%)",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      width: 1.5,
                      height: 7,
                      backgroundColor: "#111827",
                      transform: "translate(-50%, -50%)",
                    }}
                  />
                </div>
              </button>
            </div>
          ) : (
            <button
              onClick={() => setSidebarCollapsed(true)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
                padding: 0,
                width: 32,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 14,
                  borderRadius: 4,
                  border: "1.5px solid #111827",
                  display: "flex",
                  flexDirection: "row",
                  overflow: "hidden",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    width: "45%",
                    borderRight: "1.5px solid #111827",
                    backgroundColor: "transparent",
                  }}
                />
                <div style={{ flex: 1 }} />
              </div>
          </button>
          )}
        </div>

        {/* 发布新的 Campaign（仅按钮，无额外说明文字） */}
        {!sidebarCollapsed && (
          <div style={{ padding: "12px", borderBottom: "1px solid #E5E7EB" }}>
            <button
              onClick={() => handleQuickAction("publish")}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #E5E7EB",
                background: "#FFFFFF",
                color: "#1F2937",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                justifyContent: "flex-start",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                e.target.style.backgroundColor = "#F3F4F6";
                e.target.style.borderColor = "#111827";
              }}
              onMouseLeave={(e) => {
                e.target.style.backgroundColor = "#FFFFFF";
                e.target.style.borderColor = "#E5E7EB";
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  border: "1.5px solid #111827",
                  position: "relative",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: 8,
                    height: 1.5,
                    backgroundColor: "#111827",
                    transform: "translate(-50%, -50%)",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: 1.5,
                    height: 8,
                    backgroundColor: "#111827",
                    transform: "translate(-50%, -50%)",
                  }}
                />
              </div>
              <span>发布 Campaign</span>
            </button>
          </div>
        )}

        {/* Campaign 草稿 + 已发布 Campaign */}
        <div style={{ flex: 1, padding: "12px", overflowY: "auto" }}>
          {sidebarCollapsed ? null : (
            <>
              {/* 只有在存在草稿 / 已发布会话，或加载/拉取出错时，才展示下方列表，避免在完全空状态点击发布按钮时闪烁文字 */}
              {(sessionsError ||
                campaignSessions.length > 0 ||
                publishedSessions.length > 0) && (
                <>
                  {/* Campaign 草稿列表（仅在有草稿时展示） */}
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: "#9CA3AF",
                        marginBottom: 8,
                        textTransform: "uppercase",
                      }}
                    >
              Campaign 草稿
            </div>
          {loadingSessions ? (
                      <div
                        style={{
                          padding: "12px",
              fontSize: 12,
              color: "#9CA3AF",
                        }}
                      >
                        加载中...
            </div>
          ) : sessionsError ? (
                      <div
                        style={{
                          padding: "12px",
              fontSize: 11,
              color: "#EF4444",
                          lineHeight: 1.4,
                        }}
                      >
                  <div style={{ marginBottom: 4, fontWeight: 600 }}>加载失败</div>
                  <div style={{ fontSize: 10, color: "#9CA3AF" }}>{sessionsError}</div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      loadCampaignSessions();
                    }}
                    style={{
                      marginTop: 8,
                      padding: "4px 8px",
                      fontSize: 10,
                      backgroundColor: "#3B82F6",
                      color: "#FFFFFF",
                      border: "none",
                      borderRadius: 4,
                            cursor: "pointer",
                    }}
                  >
                    重试
                  </button>
            </div>
          ) : campaignSessions.length === 0 ? (
                      <div
                        style={{
                          padding: "4px 0 8px",
              fontSize: 12,
              color: "#9CA3AF",
                        }}
                      >
                        暂无草稿
            </div>
          ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          marginBottom: 4,
                        }}
                      >
              {campaignSessions.map((session) => {
                const isActive = session.id === currentSessionId;
                return (
                  <div
                    key={session.id}
                    onClick={() => handleSwitchSession(session.id)}
                    style={{
                                padding: "10px 12px",
                      borderRadius: 8,
                      backgroundColor: isActive ? "#E0F2FE" : "#FFFFFF",
                      border: `1px solid ${isActive ? "#3B82F6" : "#E5E7EB"}`,
                      cursor: "pointer",
                      fontSize: 12,
                      color: "#1F2937",
                      display: "flex",
                      alignItems: "center",
                                justifyContent: "space-between",
                      gap: 8,
                      position: "relative",
                                transition: "all 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.backgroundColor = "#F3F4F6";
                        e.currentTarget.style.borderColor = "#D1D5DB";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.backgroundColor = "#FFFFFF";
                        e.currentTarget.style.borderColor = "#E5E7EB";
                      }
                    }}
                  >
                        <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                            fontWeight: isActive ? 600 : 500,
                            marginBottom: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                            {session.title || "未命名草稿"}
                          </div>
                                <div
                                  style={{
                            fontSize: 10,
                            color: "#9CA3AF",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                            {session.updatedAt 
                                    ? new Date(session.updatedAt).toLocaleString("zh-CN", {
                                        month: "short",
                                        day: "numeric",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })
                                    : ""}
                          </div>
                        </div>
                        <button
                          onClick={(e) => handleDeleteSession(session.id, e)}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: "4px",
                            color: "#9CA3AF",
                            fontSize: 14,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            borderRadius: 4,
                                  transition: "all 0.2s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "#EF4444";
                            e.currentTarget.style.backgroundColor = "#FEE2E2";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = "#9CA3AF";
                            e.currentTarget.style.backgroundColor = "transparent";
                          }}
                          title="删除草稿"
                        >
                          ×
                        </button>
                  </div>
                );
              })}
            </div>
          )}
                  </div>

                  {/* 已发布 Campaign 区块：仅在有已发布时展示标题和列表 */}
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#9CA3AF",
                  marginBottom: 8,
                        textTransform: "uppercase",
                }}
              >
                已发布 Campaign
              </div>
              {loadingSessions ? (
                <div
                  style={{
                    padding: "8px 0",
                    fontSize: 12,
                          color: "#9CA3AF",
                  }}
                >
                  加载中...
                </div>
              ) : publishedSessions.length === 0 ? (
                <div
                  style={{
                    padding: "4px 0",
                    fontSize: 12,
                          color: "#9CA3AF",
                  }}
                >
                  暂无已发布的 Campaign
                </div>
              ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                  {publishedSessions.map((session) => {
                    const isActive = session.id === currentSessionId;
                    return (
                      <div
                        key={session.id}
                        onClick={() => handleSwitchSession(session.id)}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 8,
                          backgroundColor: isActive ? "#EEF2FF" : "#FFFFFF",
                          border: `1px solid ${isActive ? "#4F46E5" : "#E5E7EB"}`,
                          cursor: "pointer",
                          fontSize: 12,
                          color: "#1F2937",
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                                transition: "all 0.2s",
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor = "#F3F4F6";
                            e.currentTarget.style.borderColor = "#D1D5DB";
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor = "#FFFFFF";
                            e.currentTarget.style.borderColor = "#E5E7EB";
                          }
                        }}
                      >
                        <div
                          style={{
                            fontWeight: isActive ? 600 : 500,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                          }}
                        >
                          {session.title || "已发布 Campaign"}
                        </div>
                        {session.updatedAt && (
                          <div
                            style={{
                              fontSize: 10,
                              color: "#9CA3AF",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                            }}
                          >
                            {new Date(session.updatedAt).toLocaleString("zh-CN", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                                    minute: "2-digit",
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* 中间和右侧面板容器 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
          position: "relative"
        }}
      >
        {/* 右侧主区域：空状态时占满右侧（学习 Manus），有对话时再拆分中间/右侧 */}
        <div
          style={{
            width: isEmptyState ? "100%" : `${middlePanelWidth}%`,
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid #E5E7EB",
            backgroundColor: "#FFFFFF",
            transition: "width 0.2s ease"
          }}
        >
          <main
            style={{
              flex: 1,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              backgroundColor: "#FFFFFF"
            }}
          >
        {isEmptyState ? (
          // 空状态：欢迎界面（学习 DeepSeek / Manus，右侧区域正中央）
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              height: "100%",
              padding: "24px 40px",
              boxSizing: "border-box"
            }}
          >
            <div
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: "#1F2937",
                marginBottom: 12,
                fontFamily: "system-ui, -apple-system, sans-serif"
              }}
            >
              Maxin AI
            </div>
            
            <div
              style={{
                fontSize: 18,
                color: "#6B7280",
                marginBottom: 48,
                textAlign: "center"
              }}
            >
              我是 Bin，你的红人营销助手
            </div>

            {/* 大输入框 */}
            <form
              onSubmit={handleSend}
              style={{
                width: "100%",
                maxWidth: 600,
                marginBottom: 24
              }}
            >
              <div
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  backgroundColor: "#FFFFFF",
                  borderRadius: 16,
                  border: inputFocused ? "2px solid #111827" : "2px solid #E5E7EB",
                  padding: "12px 16px",
                  transition: "all 0.2s",
                  boxShadow: inputFocused 
                    ? "0 4px 12px rgba(15, 23, 42, 0.18)" 
                    : "0 2px 8px rgba(0,0,0,0.04)"
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 12,
                    flexShrink: 0
                  }}
                >
                  <BinLogo size={22} />
                </div>
                <textarea
                  ref={inputTextAreaRefMain}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  rows={1}
                  placeholder="发送消息给 Bin"
                  style={{
                    flex: 1,
                    resize: "none",
                    border: "none",
                    outline: "none",
                    fontSize: 15,
                    backgroundColor: "transparent",
                    color: "#1F2937",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                    lineHeight: 1.5,
                    minHeight: 24,
                    maxHeight: 220,
                    overflowY: "auto"
                  }}
                  onKeyDown={(e) => {
                    const isComposing =
                      e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229;
                    if (isComposing) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend(e);
                    }
                  }}
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    border: "none",
              background: loading || !input.trim()
                      ? "#E5E7EB"
                      : "#60A5FA",
              color: loading || !input.trim() ? "#9CA3AF" : "#FFFFFF",
                    cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "all 0.2s",
                    flexShrink: 0,
                    marginLeft: 8
                  }}
                  onMouseEnter={(e) => {
                    if (!loading && input.trim()) {
                      e.target.style.transform = "translateY(-1px)";
                      e.target.style.boxShadow = "0 2px 8px rgba(59, 130, 246, 0.4)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!loading && input.trim()) {
                      e.target.style.transform = "translateY(0)";
                      e.target.style.boxShadow = "none";
                    }
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="22" y1="2" x2="11" y2="13"></line>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                  </svg>
                </button>
              </div>
            </form>
          </div>
        ) : (
          // 有对话时：显示聊天界面
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              padding: "20px",
              boxSizing: "border-box",
              overflow: "hidden"
            }}
          >
            <div
              ref={chatContainerRef}
              style={{
                flex: 1,
                overflowY: "auto",
                paddingRight: 8
              }}
              onScroll={(e) => {
                // 检测用户是否手动滚动
                const container = e.target;
                const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200;
                // 如果用户不在底部附近，禁用自动滚动（用户可能在查看历史消息）
                if (!isNearBottom) {
                  shouldAutoScrollRef.current = false;
                } else {
                  // 如果用户滚动回底部，重新启用自动滚动
                  shouldAutoScrollRef.current = true;
                }
              }}
            >
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    justifyContent:
                      m.role === "user" ? "flex-end" : "flex-start",
                    marginBottom: 16,
                    animation: "fadeIn 0.3s ease-in"
                  }}
                >
                  <div
                    style={{
                      maxWidth: "80%",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      alignItems: m.role === "assistant" ? "flex-start" : "flex-end"
                    }}
                  >
                    {m.role === "assistant" && (
                      <div style={{ marginLeft: 2 }}>
                        <BinLogo size={22} />
                      </div>
                    )}
                    {m.content && (
                      <div
                        style={{
                          padding: "12px 16px",
                          borderRadius: 12,
                          backgroundColor:
                            m.role === "user"
                              ? "#F3F4F6"
                              : "#FFFFFF",
                          color: m.role === "user" ? "#111827" : "#1F2937",
                          fontSize: 14,
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.6,
                          border: "1px solid #E5E7EB",
                          boxShadow: "none",
                          wordBreak: "break-word", // 防止长链接/长词溢出
                          overflowWrap: "break-word"
                        }}
                      >
                        {renderMessageContent(m.content)}
                      </div>
                    )}
                    {/* 思考过程展示 - 精简版（类似 Manus / Cursor） */}
                    {m.role === "assistant" && m.thinking && m.thinking.steps && m.thinking.steps.length > 0 && !m.content && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: "8px 12px",
                          borderRadius: 999,
                          backgroundColor: "#F3F4F6",
                          fontSize: 12,
                          color: "#6B7280",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          maxWidth: "100%"
                        }}
                      >
                        <span
                          className="thinking-dot"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            backgroundColor: "#60A5FA",
                            display: "inline-block"
                          }}
                        />
                        <span style={{ whiteSpace: "nowrap" }}>Bin 正在思考</span>
                        <span style={{ whiteSpace: "nowrap" }}>·</span>
                        <span style={{ whiteSpace: "nowrap" }}>
                          {translateToBusinessLanguage(
                            m.thinking.steps[m.thinking.steps.length - 1].agent,
                            m.thinking.steps[m.thinking.steps.length - 1].action,
                            m.thinking.steps[m.thinking.steps.length - 1].result
                          ).title}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            
            {/* 输入框 */}
            <form
              onSubmit={handleSend}
              style={{
                paddingTop: "16px",
                borderTop: "1px solid #E5E7EB",
                flexShrink: 0
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-end"
                }}
              >
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                borderRadius: 12,
                border: "1px solid #D1D5DB",
                padding: "6px 8px 6px 12px",
                backgroundColor: "#FFFFFF"
              }}
            >
              <textarea
                ref={inputTextAreaRefFooter}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={1}
                placeholder="发送消息给 Bin"
                style={{
                  flex: 1,
                  resize: "none",
                  border: "none",
                  fontSize: 14,
                  backgroundColor: "transparent",
                  color: "#1F2937",
                  outline: "none",
                  fontFamily: "system-ui, -apple-system, sans-serif",
                  minHeight: 32,
                  maxHeight: 220,
                  overflowY: "auto"
                }}
                onKeyDown={(e) => {
                  const isComposing =
                    e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229;
                  if (isComposing) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend(e);
                  }
                }}
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  border: "none",
                  marginLeft: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                  backgroundColor: loading || !input.trim() ? "#E5E7EB" : "#60A5FA",
                  color: loading || !input.trim() ? "#9CA3AF" : "#FFFFFF",
                  transition: "all 0.2s",
                  fontSize: 14
                }}
              >
                ➤
              </button>
            </div>
          </div>
        </form>
          </div>
        )}
          </main>
        </div>

        {/* 拖拽调整宽度的分隔条 */}
        {!isEmptyState && (
          <div
            onMouseDown={handleMouseDown}
            style={{
              width: "4px",
              backgroundColor: "#E5E7EB",
              cursor: "col-resize",
              flexShrink: 0,
              transition: "background-color 0.2s",
              zIndex: 10
            }}
            onMouseEnter={(e) => {
              e.target.style.backgroundColor = "#0F172A";
            }}
            onMouseLeave={(e) => {
              if (!isResizingRef.current) {
                e.target.style.backgroundColor = "#E5E7EB";
              }
            }}
          />
        )}

        {/* 右侧：Agent 工作界面（浏览器截图和步骤） */}
        {!isEmptyState && (
          <div
            style={{
              width: `${100 - middlePanelWidth}%`,
              display: "flex",
              flexDirection: "column",
              backgroundColor: "#F9FAFB",
              borderLeft: "1px solid #E5E7EB",
              overflow: "hidden",
              transition: "width 0.2s ease"
            }}
          >
            {/* 右侧面板标题栏 - 可折叠 */}
            <div style={{
              padding: "12px 16px",
              borderBottom: "1px solid #E5E7EB",
              backgroundColor: "#FFFFFF",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: "#1F2937",
                display: "flex",
                alignItems: "center",
                gap: 8
              }}>
                💻 Bin的电脑
              </div>
            </div>
            <div style={{
              flex: 1,
              overflow: "hidden",
              padding: "16px",
              display: "flex",
            flexDirection: "column"
            }}>
              {/* 显示右侧 Agent 工作区域：根据 workflowState 在「发布阶段」和「执行阶段」之间切换布局 */}
              {(() => {
                const lastMessage = messages[messages.length - 1];
                if (!lastMessage || lastMessage.role !== "assistant" || !lastMessage.thinking) {
                  return (
                    <div style={{
                      padding: "40px 20px",
                      textAlign: "center",
                      color: "#9CA3AF",
                      fontSize: 14
                    }}>
                      等待 Agent 开始工作...
                    </div>
                  );
                }

                const isExecutionPhase =
                  context?.workflowState === "published" || context?.published === true;

                const { browserSteps, screenshots, influencerAnalyses } =
                  lastMessage.thinking || {};

                // 执行阶段：上「工作笔记」（执行节奏 + 汇报方式）、下「执行进度」（单阶段 Tab）
                if (isExecutionPhase) {
                  const cols = executionStatus?.columns || {};
                  const stageDefs = [
                    { key: "pendingPrice", title: "待审核价格", items: cols.pendingPrice || [] },
                    { key: "pendingSample", title: "待寄样品", items: cols.pendingSample || [] },
                    { key: "pendingDraft", title: "待审核草稿", items: cols.pendingDraft || [] },
                    { key: "published", title: "已发布视频", items: cols.published || [] },
                  ];
                  const currentStage =
                    stageDefs.find((s) => s.key === activeExecutionStage) || stageDefs[0];
                  const currentItems = currentStage.items;

                  // 工作笔记：来自执行节奏 + 汇报配置
                  const config = executionConfig;
                  const influencersPerDay =
                    config?.influencersPerDay ?? executionStatus?.influencersPerDay ?? null;
                  const report = config?.reportConfig || null;
                  const intervalHours = report?.intervalHours ?? null;
                  const reportTime = report?.reportTime || null;
                  const contentPreference = report?.contentPreference || null;
                  const includeMetrics = report?.includeMetrics || [];

                  return (
                    <div
                      id="right-panel-split-container"
                      style={{
                        flex: 1,
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column"
                      }}
                    >
                      {/* 上：工作笔记（可上下拖拽调整高度） */}
                      <div style={{
                        flex: rightPanelSplit,
                        minHeight: 0,
                        border: "1px solid #E5E7EB",
                        borderRadius: 12,
                        overflow: "hidden",
                        backgroundColor: "#FFFFFF",
                        display: "flex",
                        flexDirection: "column"
                      }}>
                        <div style={{
                          padding: "10px 12px",
                          fontSize: 12,
                          fontWeight: 600,
                          color: "#6B7280",
                          backgroundColor: "#F9FAFB",
                          borderBottom: "1px solid #E5E7EB"
                        }}>
                          工作笔记
                        </div>
                        <div style={{
                          flex: 1,
                          minHeight: 0,
                          overflowY: "auto",
                          padding: "12px"
                        }}>
                          {executionConfigError ? (
                            <div style={{ fontSize: 12, color: "#EF4444" }}>
                              {executionConfigError}
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              <div style={{ fontSize: 12, color: "#4B5563", lineHeight: 1.7 }}>
                                <div style={{ marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600 }}>执行节奏：</span>
                                  {influencersPerDay
                                    ? `每天联系 ${influencersPerDay} 位红人`
                                    : "尚未设置每天联系的红人数量"}
                                </div>
                                <div style={{ marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600 }}>汇报频率：</span>
                                  {intervalHours
                                    ? `每 ${intervalHours} 小时汇报一次`
                                    : "尚未设置汇报频率"}
                                </div>
                                <div style={{ marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600 }}>汇报时间：</span>
                                  {reportTime ? `每日 ${reportTime}` : "尚未设置具体汇报时间"}
                                </div>
                                <div style={{ marginBottom: 4 }}>
                                  <span style={{ fontWeight: 600 }}>汇报形式：</span>
                                  {contentPreference === "brief"
                                    ? "简要汇总"
                                    : contentPreference === "detailed"
                                    ? "详细报告"
                                    : contentPreference === "summary_only"
                                    ? "仅汇总数字"
                                    : "尚未设置汇报形式"}
                                </div>
                                <div>
                                  <span style={{ fontWeight: 600 }}>重点指标：</span>
                                  {Array.isArray(includeMetrics) && includeMetrics.length > 0
                                    ? includeMetrics.join("，")
                                    : "当前日报中未配置额外指标"}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 上下拖拽分隔条 */}
                      <div
                        onMouseDown={handleVerticalMouseDown}
                        style={{
                          height: "4px",
                          cursor: "row-resize",
                          margin: "4px 0",
                          flexShrink: 0,
                          background:
                            "linear-gradient(to right, transparent 0%, #D1D5DB 20%, #D1D5DB 80%, transparent 100%)"
                        }}
                      />

                      {/* 下：执行进度（单阶段 Tab + 红人卡片） */}
                      <div style={{
                        flex: 100 - rightPanelSplit,
                        minHeight: 0,
                        border: "1px solid #E5E7EB",
                        borderRadius: 12,
                        overflow: "hidden",
                        backgroundColor: "#FFFFFF",
                        display: "flex",
                        flexDirection: "column"
                      }}>
                        <div style={{
                        padding: "10px 12px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#6B7280",
                        backgroundColor: "#F9FAFB",
                        borderBottom: "1px solid #E5E7EB"
                      }}>
                          执行进度
                        </div>
                        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "12px" }}>
                          {executionLoading ? (
                            <div
                              style={{
                                fontSize: 12,
                                color: "#9CA3AF",
                                textAlign: "center",
                                paddingTop: 12
                              }}
                            >
                              加载执行进度中…
                            </div>
                          ) : executionError ? (
                            <div
                              style={{
                                fontSize: 12,
                                color: "#EF4444",
                                textAlign: "center",
                                paddingTop: 12
                              }}
                            >
                              {executionError}
                            </div>
                          ) : !executionStatus ? (
                            <div
                              style={{
                                fontSize: 12,
                                color: "#9CA3AF",
                                textAlign: "center",
                                paddingTop: 12
                              }}
                            >
                              暂无执行数据。
                            </div>
                          ) : (
                            <>
                              {/* 阶段 Tab 切换 */}
                              <div
                                style={{
                                  marginBottom: 8,
                                  display: "flex",
                                  gap: 8,
                                  flexWrap: "wrap"
                                }}
                              >
                                {stageDefs.map((stage) => {
                                  const isActive = stage.key === currentStage.key;
                                  return (
                                    <button
                                      key={stage.key}
                                      type="button"
                                      onClick={() => setActiveExecutionStage(stage.key)}
                                      style={{
                                        padding: "4px 10px",
                                        borderRadius: 999,
                                        border: isActive ? "1px solid #4F46E5" : "1px solid #E5E7EB",
                                        backgroundColor: isActive ? "#EEF2FF" : "#FFFFFF",
                                        color: isActive ? "#3730A3" : "#4B5563",
                                        fontSize: 12,
                                        cursor: "pointer"
                                      }}
                                    >
                                      {stage.title}（{stage.items.length}）
                                    </button>
                                  );
                                })}
                              </div>

                              {/* 当前阶段的红人卡片列表 */}
                              <div
                                style={{
                                  flex: 1,
                                  minHeight: 0,
                                  overflowY: "auto",
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 8
                                }}
                              >
                                {currentItems.length === 0 ? (
                                  <div
                                    style={{
                                      fontSize: 12,
                                      color: "#9CA3AF"
                                    }}
                                  >
                                    该阶段暂无红人。
                                  </div>
                                ) : (
                                  currentItems.map((item) => (
                                    <div
                                      key={item.id}
                                      style={{
                                        padding: "8px 10px",
                                        borderRadius: 10,
                                        backgroundColor: "#FFFFFF",
                                        border: "1px solid #E5E7EB",
                                        fontSize: 12,
                                        color: "#374151",
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 4
                                      }}
                                    >
                                      <div
                                        style={{
                                          display: "flex",
                                          justifyContent: "space-between",
                                          alignItems: "center",
                                          gap: 8
                                        }}
                                      >
                                        <div
                                          style={{
                                            fontWeight: 600,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap"
                                          }}
                                        >
                                          @{item.id || item.name}
                                        </div>
                                        {item.name && item.name !== item.id && (
                                          <div
                                            style={{
                                              fontSize: 11,
                                              color: "#6B7280",
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                              whiteSpace: "nowrap"
                                            }}
                                          >
                                            {item.name}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                }

                // ---------- 默认发布阶段：红人画像确认 + 浏览器 ----------
                
                // 红人匹配分析数据：优先使用 SSE 实时累积的 influencerAnalyses，否则从消息内容解析
                let influencerMatches = [];
                if (influencerAnalyses && influencerAnalyses.length > 0) {
                  influencerMatches = influencerAnalyses.map((inf) => ({
                    avatar: inf.avatar || '',
                    profileUrl: inf.profileUrl || '',
                    platform: inf.platform || 'TikTok',
                    id: inf.id || '',
                    name: inf.name || '',
                    followers: inf.followers || '0',
                    views: inf.views || '0',
                    reason: inf.reason || '',
                    isRecommended: inf.isRecommended,
                    analysis: inf.analysis || '',
                    score: inf.score
                  }));
                } else if (lastMessage.content) {
                  const influencerRegex = /\[INFLUENCER:([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^:]*?):([^\]]*?)\]/g;
                  let match;
                  while ((match = influencerRegex.exec(lastMessage.content)) !== null) {
                    influencerMatches.push({
                      avatar: match[1],
                      profileUrl: match[2],
                      platform: match[3],
                      id: match[4],
                      name: match[5],
                      followers: match[6],
                      views: match[7],
                      reason: match[8],
                      isRecommended: match[9] === '1' ? true : (match[9] === '0' ? false : null),
                      analysis: match[10] ? match[10].replace(/；/g, ':') : null,
                      score: null
                    });
                  }
                }

                // 只显示分析红人匹配度步骤（流式展示）
                const analyzeMatchSteps = browserSteps?.filter(step => step.id === 'analyze_match') || [];

                const currentStep = browserSteps?.find(s => s.status === 'running' && s.id === 'analyze_match') 
                  || browserSteps?.find(s => s.id === 'analyze_match');
                const currentScreenshot = (screenshots && screenshots.length > 0)
                  ? (currentStep 
                      ? screenshots
                          .filter(s => s.stepId === currentStep.id)
                          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0]
                      : screenshots
                          .filter(s => s.stepId === 'analyze_match')
                          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || screenshots[screenshots.length - 1])
                  : null;

                // 浏览器标题：显示“正在浏览 xx网址”，忽略“滚动/滑动”等技术细节
                let browserStatusLabel = "浏览器";
                const allScreenshotsSorted = (screenshots || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                const isScrollLabel = (label) =>
                  typeof label === "string" && /滚动|滑动|scroll/i.test(label);
                const buildBrowseText = (label) => {
                  if (!label) return null;
                  const urlMatch = label.match(/https?:\/\/[^\s)]+/);
                  if (urlMatch && urlMatch[0]) {
                    return `正在浏览 ${urlMatch[0]}`;
                  }
                  return label;
                };

                if (currentScreenshot && currentScreenshot.label) {
                  if (!isScrollLabel(currentScreenshot.label)) {
                    browserStatusLabel = buildBrowseText(currentScreenshot.label) || "浏览器";
                  } else {
                    // 当前是滚动等操作时，回退到最近一个“非滚动”截图的地址
                    const stableShot = [...allScreenshotsSorted]
                      .reverse()
                      .find(s => s.label && !isScrollLabel(s.label));
                    if (stableShot) {
                      browserStatusLabel = buildBrowseText(stableShot.label) || "浏览器";
                    }
                  }
                }

                return (
                  <div
                    id="right-panel-split-container"
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column"
                    }}
                  >
                    {/* 上：LLM 红人分析文档（默认 1:1，可上下拖拽调整高度） */}
                    <div style={{
                      flex: rightPanelSplit,
                      minHeight: 0,
                      border: "1px solid #E5E7EB",
                      borderRadius: 12,
                      overflow: "hidden",
                      backgroundColor: "#FFFFFF",
                      display: "flex",
                      flexDirection: "column"
                    }}>
                      <div style={{
                        padding: "10px 12px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#6B7280",
                        backgroundColor: "#F9FAFB",
                        borderBottom: "1px solid #E5E7EB"
                      }}>
                        红人画像确认
                      </div>
                      <div style={{
                        flex: 1,
                        minHeight: 0,
                        overflowY: "auto",
                        padding: "12px"
                      }}>
                        {/* 红人画像确认文档：为每位红人输出一段结构化分析，并在顶部补充用户名/链接/推荐结论 */}
                        {influencerMatches.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            {influencerMatches.map((inf, idx) => (
                              <div
                                key={`doc-${inf.id || idx}-${idx}`}
                                style={{
                                  paddingTop: idx === 0 ? 0 : 12,
                                  marginTop: idx === 0 ? 0 : 12,
                                  borderTop: idx === 0 ? "none" : "1px solid #E5E7EB"
                                }}
                              >
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                                  <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
                                    {inf.profileUrl ? (
                                      <a href={inf.profileUrl} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                                        @{inf.id || inf.name}
                                      </a>
                                    ) : (
                                      `@${inf.id || inf.name}`
                                    )}
                                  </div>
                                  <div style={{ fontSize: 11, color: "#6B7280" }}>
                                    {inf.isRecommended === true
                                      ? "✅ 推荐"
                                      : inf.isRecommended === false
                                      ? "❌ 不推荐"
                                      : "⏳ 分析中"}
                                  </div>
                                </div>
                                {/* 中段：各个维度的详细分析（来自 LLM 输出的结构化 Markdown 文本） */}
                                {inf.analysis && (
                                  <div
                                    style={{
                                      fontSize: 12,
                                      color: "#1F2937",
                                      lineHeight: 1.7,
                                      whiteSpace: "pre-wrap"
                                    }}
                                  >
                                    {inf.analysis}
                                  </div>
                                )}
                                {/* 底部：基于 isRecommended / score / reason 的结论小结 */}
                                {(inf.isRecommended != null || inf.score != null || inf.reason) && (
                                  <div
                                    style={{
                                      marginTop: 8,
                                      paddingTop: 6,
                                      borderTop: "1px solid #E5E7EB",
                                      fontSize: 12,
                                      color: "#374151"
                                    }}
                                  >
                                    <div style={{ fontWeight: 600, marginBottom: 4 }}>结论</div>
                                    {inf.score != null && (
                                      <div style={{ marginBottom: 2 }}>
                                        匹配度：{inf.score}/100
                                      </div>
                                    )}
                                    <div style={{ marginBottom: inf.reason ? 2 : 0 }}>
                                      推荐结论：
                                      {inf.isRecommended === true
                                        ? "✅ 推荐"
                                        : inf.isRecommended === false
                                        ? "❌ 不推荐"
                                        : "⏳ 分析中"}
                                    </div>
                                    {inf.reason && (
                                      <div>
                                        理由：{inf.reason}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 当前正在分析但还未形成红人卡片的流式文档（可选） */}
                        {(() => {
                          if (!analyzeMatchSteps || analyzeMatchSteps.length === 0) return null;
                          // 找到一个“正在分析中但还没有出现在 influencerMatches 里的红人”
                          const pendingStep = analyzeMatchSteps
                            .filter(s => s && typeof s.detail === 'string' && s.detail.trim())
                            .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))
                            .slice(-1)[0];
                          if (!pendingStep || !pendingStep.detail) return null;

                          const analyzingId = pendingStep.stats?.analyzing;
                          const alreadyInMatches = analyzingId &&
                            influencerMatches.some(inf => inf.id === analyzingId || inf.name === analyzingId);
                          if (alreadyInMatches) return null;

                          return (
                            <div style={{
                              marginTop: influencerMatches.length > 0 ? 16 : 0,
                              paddingTop: influencerMatches.length > 0 ? 12 : 0,
                              borderTop: influencerMatches.length > 0 ? "1px solid #E5E7EB" : "none",
                              fontSize: 12,
                              color: "#1F2937",
                              lineHeight: 1.7,
                              whiteSpace: "pre-wrap"
                            }}>
                              {analyzingId && (
                                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                                  @{analyzingId}（分析中）
                                </div>
                              )}
                              {pendingStep.detail}
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* 上下拖拽分隔条 */}
                    <div
                      onMouseDown={handleVerticalMouseDown}
                      style={{
                        height: "4px",
                        cursor: "row-resize",
                        margin: "4px 0",
                        flexShrink: 0,
                        backgroundColor: "#E5E7EB",
                        transition: "background-color 0.2s"
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.backgroundColor = "#0F172A";
                      }}
                      onMouseLeave={(e) => {
                        if (!isVerticalResizingRef.current) {
                          e.target.style.backgroundColor = "#E5E7EB";
                        }
                      }}
                    />

                    {/* 下：浏览器（默认 1:1，可上下拖拽调整高度） */}
                    <div style={{
                      flex: 100 - rightPanelSplit,
                      minHeight: 0,
                      border: "1px solid #E5E7EB",
                      borderRadius: 12,
                      overflow: "hidden",
                      backgroundColor: "#FFFFFF",
                      display: "flex",
                      flexDirection: "column"
                    }}>
                      <div style={{
                      padding: "10px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#6B7280",
                      backgroundColor: "#F9FAFB",
                      borderBottom: "1px solid #E5E7EB"
                    }}>
                        <span className={currentScreenshot ? "browser-status-blink" : undefined}>
                          {browserStatusLabel}
                        </span>
                      </div>
                      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                        {currentScreenshot ? (
                          <>
                            <img
                              src={currentScreenshot.image}
                              alt={currentScreenshot.label}
                              style={{ width: "100%", height: "auto", display: "block" }}
                            />
                            {currentScreenshot?.truncated && (
                              <div style={{
                                padding: "8px 12px",
                                fontSize: 11,
                                color: "#F59E0B",
                                backgroundColor: "#FEF3C7",
                                borderTop: "1px solid #FCD34D"
                              }}>
                                ⚠️ 提示：截图数据较大，已压缩保存
                              </div>
                            )}
                          </>
                        ) : (
                          <div style={{
                            padding: "24px 12px",
                            textAlign: "center",
                            color: "#9CA3AF",
                            fontSize: 13
                          }}>
                            暂无截图（Agent 开始浏览后会自动显示）
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.7;
          }
        }
        .thinking-step-running {
          animation: pulse 2s ease-in-out infinite;
        }
        @keyframes browserBlink {
          0% {
            opacity: 0.6;
          }
          100% {
            opacity: 1;
          }
        }
        .browser-status-blink {
          animation: browserBlink 1.2s ease-in-out infinite alternate;
        }
      `}</style>
    </div>
  );
}
