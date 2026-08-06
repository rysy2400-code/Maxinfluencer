import assert from "node:assert/strict";
import test from "node:test";

import {
  YOUTUBE_LITE_MIN_FOLLOWERS_FOR_ANALYSIS,
  hasYoutubeAboutEmail,
  isYoutubeLiteEmailGateEnabled,
  shouldSkipYoutubeLiteLowFollowers,
} from "../lib/tools/influencer-functions/youtube/extract-youtube-channel-lite.js";

test("YouTube Lite skips known follower counts below 500", () => {
  assert.equal(YOUTUBE_LITE_MIN_FOLLOWERS_FOR_ANALYSIS, 500);
  assert.equal(
    shouldSkipYoutubeLiteLowFollowers({ followers: { count: 0 } }),
    true
  );
  assert.equal(
    shouldSkipYoutubeLiteLowFollowers({ followers: { count: 499 } }),
    true
  );
});

test("YouTube Lite continues at 500 followers or above", () => {
  assert.equal(
    shouldSkipYoutubeLiteLowFollowers({ followers: { count: 500 } }),
    false
  );
  assert.equal(
    shouldSkipYoutubeLiteLowFollowers({ followers: { count: 501 } }),
    false
  );
});

test("YouTube Lite does not skip when follower data is unavailable", () => {
  assert.equal(shouldSkipYoutubeLiteLowFollowers(null), false);
  assert.equal(shouldSkipYoutubeLiteLowFollowers({ followers: null }), false);
  assert.equal(
    shouldSkipYoutubeLiteLowFollowers({ followers: { count: null } }),
    false
  );
  assert.equal(
    shouldSkipYoutubeLiteLowFollowers({ followers: { count: "hidden" } }),
    false
  );
});

test("YouTube Lite accepts numeric follower strings from persisted data", () => {
  assert.equal(
    shouldSkipYoutubeLiteLowFollowers({ followers: { count: "499" } }),
    true
  );
  assert.equal(
    shouldSkipYoutubeLiteLowFollowers({ followers: { count: "500" } }),
    false
  );
});

test("YouTube Lite email gate is fail-closed unless explicitly disabled with 0", () => {
  assert.equal(isYoutubeLiteEmailGateEnabled(undefined), true);
  assert.equal(isYoutubeLiteEmailGateEnabled(""), true);
  assert.equal(isYoutubeLiteEmailGateEnabled("0"), false);
  assert.equal(isYoutubeLiteEmailGateEnabled(" 0 "), false);
  assert.equal(isYoutubeLiteEmailGateEnabled("true"), true);
  assert.equal(isYoutubeLiteEmailGateEnabled("1"), true);
  assert.equal(isYoutubeLiteEmailGateEnabled(" 1 "), true);
});

test("YouTube Lite accepts only emails parsed from the current About data", () => {
  for (const aboutEmailSource of [
    "about_description",
    "about_mailto_link",
    "about_external_link",
  ]) {
    assert.equal(
      hasYoutubeAboutEmail({ email: "creator@example.com", aboutEmailSource }),
      true
    );
  }

  assert.equal(hasYoutubeAboutEmail({ email: "creator@example.com" }), false);
  assert.equal(
    hasYoutubeAboutEmail({
      email: "creator@example.com",
      aboutEmailSource: "persisted_record",
    }),
    false
  );
  assert.equal(
    hasYoutubeAboutEmail({ email: null, aboutEmailSource: "about_description" }),
    false
  );
});
