#!/usr/bin/env python3
"""Verify and prepare an immutable local Android distribution folder. Never uploads or installs."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tempfile

spec = importlib.util.spec_from_file_location('update_publisher', Path(__file__).with_name('prepare-update.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def package(args):
    publisher.require(args.apk.is_file(), '正式APK不存在；请先使用固定正式签名执行assembleRelease')
    publisher.require(not args.output.exists(), '交付目录已存在；不可覆盖旧安装包或回执')
    publisher.require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,39}', args.version), '版本名称无效')
    publisher.require('..' not in args.version and 0 < args.build <= 2100000000, '版本名称或构建号无效')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.android-release-', dir=args.output.parent) as temporary:
        root = Path(temporary)
        # Hash and inspect the copied artifact so a later build cannot replace it during verification.
        copied = root/'candidate.apk'
        shutil.copyfile(args.apk, copied)
        with copied.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        filename = f'MBOX-Staff-{args.version}-build{args.build}-{digest[:12]}.apk'
        artifact = root/filename
        copied.rename(artifact)
        feed = root/'stable.json'
        if args.previous_feed:
            shutil.copyfile(args.previous_feed, feed)
        item = publisher.prepare(argparse.Namespace(
            platform='android', channel='stable', apk=artifact, notes=args.notes, output=feed,
            priority=args.priority, aapt=args.aapt, apksigner=args.apksigner,
            certificate_sha256=args.certificate_sha256,
            url=f'https://mbox.shmbox.com/native-updates/staff/{filename}',
        ))
        publisher.require(item['version'] == args.version and item['build'] == args.build,
                          '实际APK与声明版本不一致；不生成交付目录')
        (root/'verification.json').write_text(json.dumps({
            'schemaVersion': 1,
            'release': item,
            'certificateSha256': args.certificate_sha256.lower(),
            'apkDebuggable': False,
            'allowLocalDemo': False,
            'channel': 'stable',
            'previousFeedProvided': args.previous_feed is not None,
            'published': False,
            'installedOnDevice': False,
        }, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        (root/'安装与发布说明.txt').write_text(
            '本目录为已校验的本地正式签名候选，尚未上传或完成真机验收。\n'
            '新设备可安装APK；正式签名不同于历史调试包，不能覆盖该调试包。\n'
            '已有测试包的手机须先核对未决业务、草稿和账号迁移，勿直接卸载。\n'
            '同正式证书的后续递增版本可覆盖升级。首次安装不会读取旧签名应用的私有数据。\n'
            '发布时先放置不可变APK并核验HTTPS实际摘要，再原子更新stable.json。\n'
            'verification.json只证明本地包校验，不证明正式上线或门店验收。\n', encoding='utf-8')
        # Same-filesystem rename publishes all local candidate files together, after every check passes.
        root.rename(args.output)
    return item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--notes', type=Path, required=True)
    parser.add_argument('--aapt', type=Path, required=True)
    parser.add_argument('--apksigner', type=Path, required=True)
    parser.add_argument('--certificate-sha256', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--build', type=int, required=True)
    parser.add_argument('--previous-feed', type=Path)
    parser.add_argument('--priority', choices=['normal', 'urgent'], default='normal')
    args = parser.parse_args()
    try:
        item = package(args)
        print(f"已校验本地正式候选 {item['version']} ({item['build']})：{args.output}；未上传、未安装。")
    except (ValueError, OSError, publisher.subprocess.CalledProcessError) as error:
        parser.exit(1, f'准备失败：{error}\n')


if __name__ == '__main__':
    main()
