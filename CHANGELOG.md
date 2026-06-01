# Changelog

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
