"""Generate an authored, deterministic ZIP fixture; no downloaded assets."""
import argparse
import pathlib
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
args = parser.parse_args()
target = pathlib.Path(args.out)
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for index in range(300):
        suffix = ['.gd', '.py', '.json'][index % 3]
        member = zipfile.ZipInfo(f'demo/{index:04d}{suffix}', date_time=(2020, 1, 1, 0, 0, 0))
        member.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(member, f'Authored evidence fixture record {index}\n'.encode())
    for name, content in [('demo/ไทย.gd', 'Unicode path\n'), ('demo/duplicate-a.txt', 'Same bytes\n'), ('demo/duplicate-b.txt', 'Same bytes\n'), ('demo/empty.txt', ''), ('demo/empty-directory/', '')]:
        member = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
        member.compress_type = zipfile.ZIP_DEFLATED
        if name.endswith('/'):
            member.external_attr = (0o40755 << 16) | 0x10
        archive.writestr(member, content.encode())
print(f'Created {target}: 304 files and one explicit directory; synthetic fixture.')
