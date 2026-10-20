"""Independent stdlib oracle: read every ZIP member and verify CRC and SHA-256."""
import argparse
import hashlib
import json
import pathlib
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--archive', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
archive = pathlib.Path(args.archive)
files = []
raw_files = []
raw_directories = 0
directories = 0
with zipfile.ZipFile(archive) as source:
    for member in source.infolist():
        body = source.read(member)
        raw_name = member.orig_filename
        if raw_name.endswith('/'):
            raw_directories += 1
        else:
            raw_files.append({'path': raw_name, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
        if member.is_dir():
            directories += 1
            continue
        body = source.read(member)  # Checks the ZIP CRC as well as decompression.
        files.append({'path': member.filename, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
files.sort(key=lambda item: item['path'].encode('utf-8'))
raw_files.sort(key=lambda item: item['path'].encode('utf-8'))
extensions = {}
for item in files:
    suffix = pathlib.PurePosixPath(item['path']).suffix.lower()
    extensions[suffix] = extensions.get(suffix, 0) + 1
result = {'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
          'files': files, 'directories': directories, 'fileBytes': sum(item['bytes'] for item in files),
          'extensions': [{'extension': key, 'count': extensions[key]} for key in sorted(extensions, key=lambda key: key.encode('utf-8'))]}
raw_extensions = {}
for item in raw_files:
    suffix = pathlib.PurePosixPath(item['path']).suffix.lower()
    raw_extensions[suffix] = raw_extensions.get(suffix, 0) + 1
result['rawHeader'] = {'files': raw_files, 'directories': raw_directories,
                      'fileBytes': sum(item['bytes'] for item in raw_files),
                      'extensions': [{'extension': key, 'count': raw_extensions[key]} for key in sorted(raw_extensions, key=lambda key: key.encode('utf-8'))]}
result['pathInterpretationDisagreement'] = len(files) != len(raw_files) or directories != raw_directories
target = pathlib.Path(args.out)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'filesVerified': len(files), 'directories': directories, 'bytes': result['fileBytes']}))
