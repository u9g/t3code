import { describe, expect, it } from "vite-plus/test";

import { markdownFilePathDestination } from "@t3tools/shared/markdownLinks";

import { classifyMarkdownImageSource } from "./markdownImages.js";

describe("classifyMarkdownImageSource", () => {
  it.each([
    ["images/result.png", "/workspace/project", "/workspace/project/images/result.png"],
    [
      "images\\result.png",
      "C:\\Users\\dara\\project",
      "C:\\Users\\dara\\project\\images\\result.png",
    ],
    ["file:///workspace/project/image%20one.png", null, "/workspace/project/image one.png"],
    ["file://server/share/image.png", "\\\\server\\share", "\\\\server\\share\\image.png"],
  ])("maps %s to a workspace file", (source, workspaceRoot, path) => {
    expect(classifyMarkdownImageSource(source, workspaceRoot)).toEqual({
      _tag: "WorkspaceFile",
      path,
    });
  });

  it.each(["image.png", "javascript:alert(1)", "file://%"])(
    "blocks unsupported or unresolved source %s",
    (source) => {
      expect(classifyMarkdownImageSource(source)).toEqual({ _tag: "Blocked" });
    },
  );

  it.each([
    [
      "C:\\Users\\Jo Smith\\.t3\\userdata\\files\\clip (1) #2%.mp4",
      "C:/Users/Jo Smith/.t3/userdata/files/clip (1) #2%.mp4",
    ],
    [
      "/home/jo smith/.t3/userdata/files/clip (1) #2%.mp4",
      "/home/jo smith/.t3/userdata/files/clip (1) #2%.mp4",
    ],
  ])("reads a destination built from %s back as the file", (path, expected) => {
    expect(classifyMarkdownImageSource(markdownFilePathDestination(path))).toEqual({
      _tag: "WorkspaceFile",
      path: expected,
    });
  });

  // Loading these makes Windows send the user's NTLM credentials to the named host.
  it.each([
    "file://attacker.test/share/cat.jpg",
    "\\\\attacker.test\\share\\cat.jpg",
    "/\\attacker.test\\share\\cat.jpg",
    "file:/%5Cattacker.test%5Cshare%5Ccat.jpg",
    "\\\\server\\other\\cat.jpg",
  ])("blocks network path %s outside the project", (source) => {
    expect(classifyMarkdownImageSource(source, "\\\\server\\share\\project")).toEqual({
      _tag: "Blocked",
    });
  });
});
