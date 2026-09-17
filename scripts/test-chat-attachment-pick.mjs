// 回归测试：选文件后必须先把 FileList 快照成数组，再清空 input.value。
//
// 背景：input.files 是实时列表。若先 `e.target.value = ""` 再读文件，
// 列表已被清空 → 上传函数收到空数组直接 return：不报错、不提示、也不上传
// （用户侧表现为「点了上传，聊天框没反应」）。
//
// 运行：node scripts/test-chat-attachment-pick.mjs

import assert from "node:assert/strict";
import { snapshotPickedFiles } from "../app/chat-file-utils.js";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok ${name}`);
}

function fakeFile(name) {
  return { name, size: 1234 };
}

/** 模拟浏览器的实时 FileList：清空 input.value 后原引用也变空。 */
function makeLiveFileList(files) {
  const list = {
    _files: [...files],
    get length() {
      return this._files.length;
    },
    item(i) {
      return this._files[i] ?? null;
    },
    [Symbol.iterator]() {
      return this._files[Symbol.iterator]();
    },
    /** 模拟 input.value = "" */
    clear() {
      this._files = [];
    },
  };
  return list;
}

console.log("[1] 快照后再清空，文件不丢");
{
  const live = makeLiveFileList([fakeFile("a.docx"), fakeFile("b.pdf")]);
  const snapshot = snapshotPickedFiles(live); // 先快照
  live.clear(); // 再清空 input
  assert.equal(snapshot.length, 2, "快照应保留 2 个文件");
  assert.equal(snapshot[0].name, "a.docx");
  assert.equal(snapshot[1].name, "b.pdf");
  assert.equal(live.length, 0, "实时列表本身已清空");
  ok("先快照后清空不会丢文件");
}

console.log("[2] 反例：先清空再快照就会拿到空数组（就是这个 bug）");
{
  const live = makeLiveFileList([fakeFile("video.mp4")]);
  live.clear(); // 先清空
  const snapshot = snapshotPickedFiles(live); // 再快照
  assert.equal(snapshot.length, 0);
  ok("复现历史 bug 的行为差异");
}

console.log("[3] 返回值是独立副本，不受源列表后续变化影响");
{
  const arr = [fakeFile("c.png")];
  const snapshot = snapshotPickedFiles(arr);
  arr.length = 0;
  assert.equal(snapshot.length, 1);
  assert.notEqual(snapshot, arr);
  ok("返回独立副本");
}

console.log("[4] 空值 / 脏数据安全");
{
  assert.deepEqual(snapshotPickedFiles(null), []);
  assert.deepEqual(snapshotPickedFiles(undefined), []);
  assert.deepEqual(snapshotPickedFiles([]), []);
  assert.equal(snapshotPickedFiles([null, fakeFile("d.pdf"), undefined]).length, 1);
  ok("空值与 null 项被过滤");
}

console.log(`\n全部通过：${passed} 项`);
