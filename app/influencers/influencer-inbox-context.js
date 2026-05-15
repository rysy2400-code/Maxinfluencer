"use client";

import React, { createContext, useContext } from "react";

const InfluencerInboxContext = createContext(null);

export function InfluencerInboxProvider({ value, children }) {
  return <InfluencerInboxContext.Provider value={value}>{children}</InfluencerInboxContext.Provider>;
}

/** 刷新左侧会话列表。opts.afterSend：发信后强确认，列表重载后滚回顶部 */
export function useInfluencerInbox() {
  return useContext(InfluencerInboxContext);
}
