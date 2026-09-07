# Changelog

## [0.4.0](https://github.com/Jomik/pi-ward/compare/v0.3.0...v0.4.0) (2026-09-07)


### Features

* add ward project commands ([4d2f223](https://github.com/Jomik/pi-ward/commit/4d2f2236d6b75f6bbaaad02ba2146b7fe6c37cb1))
* allow reads beneath prompt-approved directories ([#21](https://github.com/Jomik/pi-ward/issues/21)) ([514426d](https://github.com/Jomik/pi-ward/commit/514426d9b4b41b049e606bb524aff528de37585c))
* approve prompt-referenced external reads ([#19](https://github.com/Jomik/pi-ward/issues/19)) ([704600b](https://github.com/Jomik/pi-ward/commit/704600b0f281c0a36c23e7072ad770ec8081127a))
* persist project-scoped policy rules ([d0f4f61](https://github.com/Jomik/pi-ward/commit/d0f4f61bd2ce16f57eccafb22b99e6c474c962d3))
* support scoped session denies for all paths ([#22](https://github.com/Jomik/pi-ward/issues/22)) ([8334b4c](https://github.com/Jomik/pi-ward/commit/8334b4c7d28193b665ac5b69d1a3835c0fe86b7a))
* support unanchored path patterns ([2e4d12f](https://github.com/Jomik/pi-ward/commit/2e4d12f6472df5a06cc3085954ba9497d84cafd7))


### Bug Fixes

* harden ward config self-protection ([6790f3f](https://github.com/Jomik/pi-ward/commit/6790f3f7631187b8974a01307ef13f81bea38efc))
* use safe select prompt for project policy ([2361494](https://github.com/Jomik/pi-ward/commit/23614940664d79306b2114a189e74941356ac621))

## [0.3.0](https://github.com/Jomik/pi-ward/compare/v0.2.0...v0.3.0) (2026-08-30)


### Features

* add projectRoot-scoped global ward rules ([991b16d](https://github.com/Jomik/pi-ward/commit/991b16dc6c06eec1fac9731a69048dc605fae32f))
* report pending ward approvals to herdr ([#17](https://github.com/Jomik/pi-ward/issues/17)) ([2821fb2](https://github.com/Jomik/pi-ward/commit/2821fb2c79c45445e7a97056bd7ae13b6fd39a19))


### Bug Fixes

* expand home-relative paths before policy checks ([#18](https://github.com/Jomik/pi-ward/issues/18)) ([2d71f7f](https://github.com/Jomik/pi-ward/commit/2d71f7fd900438f3065003da2181ab8a31a7cfb9))
* **security:** filter denied-file contents from grep tool output ([f17e157](https://github.com/Jomik/pi-ward/commit/f17e157a379bb10235143620c34047ec8db35c23))

## [0.2.0](https://github.com/Jomik/pi-ward/compare/v0.1.0...v0.2.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* simplify operations to singular access level ([#6](https://github.com/Jomik/pi-ward/issues/6))

### Features

* add ~/ home-anchored pattern syntax, reject ./ in global config ([#7](https://github.com/Jomik/pi-ward/issues/7)) ([bda45ac](https://github.com/Jomik/pi-ward/commit/bda45ac2fc6518da7c1da1b46b500684dc27b931))
* add absolute-path pattern support for global config ([#12](https://github.com/Jomik/pi-ward/issues/12)) ([1c2d1fa](https://github.com/Jomik/pi-ward/commit/1c2d1faa1b9821a3ef50b6c22a8bea2092eb7711))
* add autocomplete for /ward command ([bcb70cd](https://github.com/Jomik/pi-ward/commit/bcb70cd558944297f2bb064d837cd1f748ed8c73))
* add move tool for renaming/relocating files and directories ([4565cf6](https://github.com/Jomik/pi-ward/commit/4565cf6a1bbdb2f4946d7feef6127077f8e02dbe))
* add ward.schema.json generation and CI check ([#4](https://github.com/Jomik/pi-ward/issues/4)) ([3516b28](https://github.com/Jomik/pi-ward/commit/3516b28c2e2c18494da631b2e8a128ab2d71ec2a))
* implement /ward slash command for proactive session grants ([#14](https://github.com/Jomik/pi-ward/issues/14)) ([3b69fc9](https://github.com/Jomik/pi-ward/commit/3b69fc9cb8d3dc86ccea75b9e976b6cf1c13598c))
* interactive runtime grants for baseline denies ([#13](https://github.com/Jomik/pi-ward/issues/13)) ([9d9e55e](https://github.com/Jomik/pi-ward/commit/9d9e55edc12560ce846d78a4f6a5f5ae9cdf6682))
* simplify operations to singular access level ([#6](https://github.com/Jomik/pi-ward/issues/6)) ([509b4b8](https://github.com/Jomik/pi-ward/commit/509b4b80d4cedead823f2fe2915789a7b218ad56))


### Bug Fixes

* allow writes to paths with non-existent intermediate directories ([#11](https://github.com/Jomik/pi-ward/issues/11)) ([2f0e4c0](https://github.com/Jomik/pi-ward/commit/2f0e4c01a05607f97ecf54a3b481723af419caea))
* handle empty directory deletion in delete tool ([#10](https://github.com/Jomik/pi-ward/issues/10)) ([5305890](https://github.com/Jomik/pi-ward/commit/5305890ae3dc6528efd22d6c4653649a64681575))
* reject home-anchored allow rules that can never fire due to trust scoping ([#9](https://github.com/Jomik/pi-ward/issues/9)) ([3f548aa](https://github.com/Jomik/pi-ward/commit/3f548aa0de3935d9d559a0fcd83eeba6f95e281c))

## [0.1.0](https://github.com/Jomik/pi-ward/compare/v0.0.1...v0.1.0) (2026-05-24)


### Features

* add guarded delete tool ([#3](https://github.com/Jomik/pi-ward/issues/3)) ([9a61d1c](https://github.com/Jomik/pi-ward/commit/9a61d1c1f277643e8475988c15a716e3e51e7e3d))
* implement pi-ward file access guard ([#1](https://github.com/Jomik/pi-ward/issues/1)) ([f949d36](https://github.com/Jomik/pi-ward/commit/f949d3636ef7b2afe331390bf839caa28f633513))
