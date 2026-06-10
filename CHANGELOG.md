# Changelog

All notable changes to `@asqav/pi` are listed here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org/) and track the `package.json` version.

## [Unreleased]

## [0.1.0] - 2026-06-10

Initial release. A pi coding agent extension that signs every tool call before it runs via pi's `tool_call` event and blocks a refused call, with a matching `tool:end` receipt on `tool_result`. Auto-registers from `ASQAV_API_KEY`, with `registerAsqav` for programmatic use. Fail-open by default with an opt-in fail-closed mode.
