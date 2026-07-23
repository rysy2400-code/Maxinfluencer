import assert from "node:assert/strict";
import test from "node:test";

import {
  YOUTUBE_LITE_MIN_FOLLOWERS_FOR_ANALYSIS,
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
