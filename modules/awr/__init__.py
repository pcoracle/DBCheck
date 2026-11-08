# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AWR 报告模块。

上传解析与 Word 报告在 :mod:`modules.web.app`（历史实现）；
在线生成（快照列表 / 生成 / 进度 / 预览下载 / 最近文件 / AI 流式诊断）
在 :mod:`modules.awr.routes`，以 ``awr_extra`` blueprint 注册。
"""
