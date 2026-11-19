#!/usr/bin/env python3
"""Prepare reviewed releases. Canonical source: mathias-engineering/scripts/release.py.

Distributed verbatim: no sibling checkout, third-party module or release service is required.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tomllib
from datetime import date
from pathlib import Path

SEMVER = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
STABLE = re.compile(r'v?' + SEMVER + r'(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?')
DECLARED = re.compile(SEMVER + r'(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?')
ENTRY = re.compile(r'^## \[(' + SEMVER + r')\] - (\d{4}-\d{2}-\d{2})$', re.MULTILINE)
CONVENTIONAL = re.compile(r'^([A-Za-z][A-Za-z0-9-]*)(?:\(([^\n()]+)\))?(!)?: (.+)$')


def run(arguments, *, check=True):
    result = subprocess.run(arguments, capture_output=True, text=True, check=False)
    if check and result.returncode:
        # Remote URLs and provider output can contain credentials.
        raise RuntimeError(arguments[0] + ' ' + arguments[1] + ' failed; check repository access and Git state')
    return result


def git(*arguments, check=True):
    return run(['git', *arguments], check=check)


def revision(ref):
    return git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').stdout.strip()


def contents(path, commit=None):
    if commit is None:
        return Path(path).read_text()
    return git('show', commit + ':' + path).stdout


def version(value):
    match = STABLE.fullmatch(value)
    return tuple(map(int, match.groups())) if match else None


def semantic_bump(previous, messages, override=None):
    if override not in (None, 'major', 'minor', 'patch'):
        raise ValueError('Bump must be major, minor or patch')
    breaking = any(re.match(r'^[A-Za-z][A-Za-z0-9-]*(?:\([^\n()]+\))?!:', message)
                   or re.search(r'(?m)^BREAKING(?: CHANGE|-CHANGE):', message) for message in messages)
    feature = any(re.match(r'^feat(?:\([^\n()]+\))?:', message) for message in messages)
    impact = override or ('major' if breaking else 'minor' if feature else 'patch')
    major, minor, patch = previous
    return '.'.join(map(str, (major + 1, 0, 0) if impact == 'major' else
                            (major, minor + 1, 0) if impact == 'minor' else (major, minor, patch + 1)))


def config(commit=None):
    data = json.loads(contents('.release.json', commit))
    if not isinstance(data.get('version_files'), list) or not data['version_files']:
        raise ValueError('.release.json must identify the native version file(s)')
    if data.get('tag_prefix', 'v') not in ('', 'v'):
        raise ValueError('Stable tag prefix must be empty or v')
    for item in data['version_files']:
        path = Path(item['path'])
        if path.is_absolute() or '..' in path.parts or str(path) == '.':
            raise ValueError('Version files must be paths inside this repository')
    return data


def declaration(item, text):
    """Locate one owned version without changing dependencies or tool versions."""
    path = item['path']
    key = item.get('key', 'version')
    if path.endswith('.json'):
        data = json.loads(text)
        if key not in data or not isinstance(data[key], str):
            raise ValueError(path + ' must declare a string ' + key)
        return data[key], None
    if path.endswith('pyproject.toml'):
        value = tomllib.loads(text)['project']['version']
        section = re.search(r'(?ms)^\[project\][ \t]*\n(.*?)(?=^\[|\Z)', text)
        if section is None:
            raise ValueError('Missing project version section in ' + path)
        match = re.search(r'(?m)^version[ \t]*=[ \t]*["\']([^"\'\n]+)["\']', section.group(1))
        if match is None:
            raise ValueError('Expected a literal project version in ' + path)
        return value, (section.start(1) + match.start(1), section.start(1) + match.end(1))
    patterns = {
        '.yaml': r'(?m)^version:[ \t]*["\']?([^\s"\'#]+)',
        '.kts': r'(?m)^version[ \t]*=[ \t]*"([^"\n]+)"',
        '.gradle': r'(?m)^version[ \t]*=[ \t]*["\']([^"\'\n]+)["\']',
        '.properties': r'(?m)^' + re.escape(key) + r'[ \t]*=[ \t]*([^\r\n#]+)',
        '.swift': r'\bstatic let ' + re.escape(key) + r'[ \t]*=[ \t]*"([^"\n]+)"',
        '': r'\A([^\s]+)\s*\Z',
    }
    suffix = Path(path).suffix
    if suffix not in patterns:
        raise ValueError('Unsupported native version file: ' + path)
    matches = list(re.finditer(patterns[suffix], text))
    if len(matches) != 1:
        raise ValueError('Expected exactly one native version declaration in ' + path)
    match = matches[0]
    return match.group(1).strip(), match.span(1)


def native_versions(commit=None):
    items = config(commit)['version_files']
    values = [(item, declaration(item, contents(item['path'], commit))[0]) for item in items]
    for item, value in values:
        if not DECLARED.fullmatch(value):
            raise ValueError('Invalid semantic version in ' + item['path'])
    return values


def project_version(commit=None):
    values = native_versions(commit)
    bases = {re.split(r'[-+]', value, maxsplit=1)[0] for _, value in values}
    if len(bases) != 1:
        raise ValueError('Native release versions disagree: ' + ', '.join(item['path'] for item, _ in values))
    return next(iter(bases))


def check_release(commit, branch=None):
    values = native_versions(commit)
    if any('-' in value for _, value in values):
        raise ValueError('Release versions must be stable X.Y.Z (an existing build number is permitted)')
    value = project_version(commit)
    changelog = contents('CHANGELOG.md', commit)
    headings = [h for h in re.findall(r'^## .+$', changelog, re.MULTILINE) if h.rstrip() != '## [Unreleased]']
    first = ENTRY.fullmatch(headings[0]) if headings else None
    if first is None or first.group(1) != value:
        raise ValueError('The newest changelog entry must match the native version and include its date')
    if len(re.findall(r'^## \[' + re.escape(value) + r'\]', changelog, re.MULTILINE)) != 1:
        raise ValueError('The release changelog entry must occur exactly once')
    date.fromisoformat(first.group(5))
    section = changelog[ENTRY.search(changelog).end():].split('\n## ', 1)[0]
    if not re.search(r'(?m)^- \S', section):
        raise ValueError('The release changelog needs at least one change')
    if branch and branch.startswith('release/') and branch != 'release/' + value:
        raise ValueError('Release branch name does not match the native version')
    return value


def available_version(commit, value):
    tags = git('tag').stdout.splitlines()
    existing = [tag for tag in git('tag', '--points-at', commit).stdout.splitlines() if version(tag)]
    if existing:
        if existing != [config().get('tag_prefix', 'v') + value]:
            raise ValueError('This commit already has a different release tag')
        return
    if any(version(tag) >= version(value) for tag in tags if version(tag)):
        raise ValueError('The approved version is already used or older than an existing release; no new version was allocated')


def fetch(no_fetch=False):
    if not no_fetch and git('remote', 'get-url', 'origin', check=False).returncode == 0:
        git('fetch', '--tags', 'origin')


def release_notes(messages):
    groups = {'Breaking changes': [], 'Added': [], 'Fixed': [], 'Changed': []}
    for sha, message in messages:
        subject, _, body = message.partition('\n')
        match = CONVENTIONAL.fullmatch(subject)
        footer = re.search(r'(?m)^BREAKING(?: CHANGE|-CHANGE):[ \t]*(.+)', body)
        kind, scope, marker, description = match.groups() if match else (None, None, None, subject)
        if marker or footer:
            group = 'Breaking changes'
            if footer:
                description += ' — ' + footer.group(1)
        elif kind == 'feat':
            group = 'Added'
        elif kind == 'fix':
            group = 'Fixed'
        elif kind in ('test', 'style', 'build', 'ci'):
            continue
        else:
            group = 'Changed'
        groups[group].append('- ' + (f'**{scope}**: ' if scope else '') + description + f' (`{sha[:8]}`)')
    return '\n\n'.join('### ' + name + '\n\n' + '\n'.join(items) for name, items in groups.items() if items)


def require_production_history(master, selected):
    if git('rev-list', '--no-merges', master, '--not', selected).stdout.strip():
        raise ValueError('The snapshot omits production commits; integrate master into develop first')
    for merge in git('rev-list', '--merges', master, '--not', selected).stdout.splitlines():
        if git('show', '--no-textconv', '--format=', '--cc', '--name-only', merge).stdout.strip():
            raise ValueError('Integrate master merge resolutions into develop before preparing a release')


def updated_version(item, text, value):
    previous, span = declaration(item, text)
    if item['path'].endswith('.yaml') and re.search(r'\+[0-9]+$', previous):
        value += '+' + str(int(previous.rsplit('+', 1)[1]) + 1)
    if span is not None:
        return text[:span[0]] + value + text[span[1]:]
    data = json.loads(text)
    data[item.get('key', 'version')] = value
    return render_json(data, text)


def render_json(data, original):
    indentation = re.search(r'(?m)^([ \t]+)"', original)
    return json.dumps(data, indent=indentation.group(1) if indentation else 2, ensure_ascii=False) + '\n'


def related_updates(commit, changes, values, value):
    """Keep owned workspace references and lock metadata coherent."""
    names = {}
    for item, previous in values:
        if item['path'].endswith('package.json'):
            data = json.loads(changes[item['path']])
            if data.get('name'):
                names[data['name']] = previous
    for item, _ in values:
        path = item['path']
        if not path.endswith('package.json'):
            continue
        data = json.loads(changes[path])
        changed = False
        for field in ('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'):
            for name, specifier in data.get(field, {}).items():
                if name in names and specifier in (names[name], '^' + names[name], '~' + names[name]):
                    data[field][name] = specifier.removesuffix(names[name]) + value
                    changed = True
        if changed:
            changes[path] = render_json(data, changes[path])
    for lock in ('package-lock.json', 'npm-shrinkwrap.json'):
        result = git('show', commit + ':' + lock, check=False)
        if result.returncode:
            continue
        data = json.loads(result.stdout)
        if 'version' in data:
            data['version'] = value
        for path, package in data.get('packages', {}).items():
            if path == '' or package.get('name') in names or path + '/package.json' in changes:
                if 'version' in package:
                    package['version'] = value
                for field in ('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'):
                    for name, specifier in package.get(field, {}).items():
                        if name in names and specifier in (names[name], '^' + names[name], '~' + names[name]):
                            package[field][name] = specifier.removesuffix(names[name]) + value
        changes[lock] = render_json(data, result.stdout)
    pyprojects = [item for item, _ in values if item['path'].endswith('pyproject.toml')]
    locked = git('show', commit + ':uv.lock', check=False)
    if pyprojects and locked.returncode == 0:
        names = {tomllib.loads(changes[item['path']])['project']['name'] for item in pyprojects}
        blocks = re.split(r'(?m)(?=^\[\[package\]\])', locked.stdout)
        for index, block in enumerate(blocks):
            parsed = tomllib.loads(block)
            for package in parsed.get('package', []):
                if package.get('name') in names:
                    blocks[index] = re.sub(r'(?m)^version = "[^"]+"$', 'version = "' + value + '"', block, count=1)
        changes['uv.lock'] = ''.join(blocks)


def prepare(source=None, bump=None, dry_run=False, no_fetch=False):
    if git('status', '--porcelain').stdout.strip():
        raise ValueError('Commit or stash local changes before preparing a release')
    fetch(no_fetch)
    develop = revision('develop')
    remote = git('rev-parse', '--verify', 'refs/remotes/origin/develop', check=False)
    tips = [develop, remote.stdout.strip()] if remote.returncode == 0 else [develop]
    if source is None and len(tips) == 2 and git('merge-base', '--is-ancestor', tips[1], develop, check=False).returncode:
        raise ValueError('Local develop is behind or diverged; synchronize it or choose --from explicitly')
    selected = revision(source or 'develop')
    if all(git('merge-base', '--is-ancestor', selected, tip, check=False).returncode for tip in tips):
        raise ValueError('--from must identify a commit in develop history')
    master_ref = 'refs/remotes/origin/master' if git('rev-parse', '--verify', 'refs/remotes/origin/master', check=False).returncode == 0 else 'master'
    master = revision(master_ref)
    require_production_history(master, selected)
    values = native_versions(selected)
    current = project_version(selected)
    stable = [tag for tag in git('tag', '--merged', master).stdout.splitlines() if version(tag)]
    baseline = max(stable, key=version) if stable else None
    all_tags = [tag for tag in git('tag').stdout.splitlines() if version(tag)]
    if baseline and any(version(tag) > version(baseline) for tag in all_tags):
        raise ValueError('A newer stable tag exists outside master; reconcile release history first')
    raw = git('log', '--reverse', '--no-merges', '--format=%H%x1f%B%x00', baseline + '..' + selected if baseline else selected).stdout
    messages = [tuple(record.strip().split('\x1f', 1)) for record in raw.split('\x00') if record.strip()]
    if not messages:
        raise ValueError('There are no changes since the last production release')
    previous = max(version(current), version(baseline) if baseline else (0, 0, 0))
    value = semantic_bump(previous, [message for _, message in messages], bump)
    available_version(selected, value)
    branch = 'release/' + value
    if git('show-ref', '--verify', 'refs/heads/' + branch, check=False).returncode == 0:
        raise ValueError('The local release branch already exists')
    if git('remote', 'get-url', 'origin', check=False).returncode == 0 and git('ls-remote', '--heads', 'origin', 'refs/heads/' + branch).stdout.strip():
        raise ValueError('The remote release branch already exists')
    contents('scripts/release.py', selected)
    changes = {item['path']: updated_version(item, contents(item['path'], selected), value) for item, _ in values}
    related_updates(selected, changes, values, value)
    changelog = contents('CHANGELOG.md', selected)
    markers = list(re.finditer(r'^## \[Unreleased\][ \t]*$', changelog, re.MULTILINE))
    if len(markers) != 1:
        raise ValueError('CHANGELOG.md must contain exactly one Unreleased heading')
    if re.search(r'^## \[' + re.escape(value) + r'\]', changelog, re.MULTILINE):
        raise ValueError('This version already has changelog notes')
    start = markers[0].end()
    following = re.search(r'^## ', changelog[start:], re.MULTILINE)
    end = start + following.start() if following else len(changelog)
    existing = changelog[start:end].strip()
    notes = release_notes(messages) or '- Maintenance changes; review compatibility before approving this release.'
    if existing:
        notes = existing + '\n\n' + notes
    draft = f'## [{value}] - {date.today().isoformat()}\n\n' + notes
    changes['CHANGELOG.md'] = (changelog[:start].rstrip() + '\n\n' + draft + '\n\n' + changelog[end:]).rstrip() + '\n'
    print(json.dumps({'branch': branch, 'version': value, 'baseline': baseline, 'source': selected,
                      'commits': len(messages), 'files': list(changes), 'dry_run': dry_run}))
    if dry_run:
        print('\n' + draft)
        return
    git('switch', '--create', branch, selected)
    for path, text in changes.items():
        Path(path).write_text(text)
    print('Review and commit the version/changelog, then open the release MR. No commit, push, tag or deployment was performed.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('inspect', help='Read native version configuration without changing Git or fetching')
    proposal = commands.add_parser('prepare', help='Create a release branch and draft version/changelog for review')
    proposal.add_argument('--from', dest='source', help='Commit in develop history (default: local develop HEAD)')
    proposal.add_argument('--bump', choices=('major', 'minor', 'patch'), help='Explicit human override')
    proposal.add_argument('--dry-run', action='store_true')
    proposal.add_argument('--no-fetch', action='store_true', help='Use existing local references (offline)')
    check = commands.add_parser('check', help='Validate the exact committed release metadata and tag availability')
    check.add_argument('--ref', default='HEAD')
    check.add_argument('--branch')
    check.add_argument('--tag', help='Require this exact published tag, including its target commit')
    check.add_argument('--no-fetch', action='store_true')
    commands.add_parser('version', help='Print the native semantic version without allocating one')
    commands.add_parser('tag-name', help='Print the approved tag name without creating or pushing it')
    commands.add_parser('publish', help='Use the existing backend production receipt/tag gate')
    args = parser.parse_args(argv)
    try:
        os.chdir(git('rev-parse', '--show-toplevel').stdout.strip())
        if args.command == 'inspect':
            print(json.dumps({'version': project_version(), **config()}))
        elif args.command == 'version':
            print(project_version())
        elif args.command == 'tag-name':
            print(config().get('tag_prefix', 'v') + project_version())
        elif args.command == 'prepare':
            prepare(args.source, args.bump, args.dry_run, args.no_fetch)
        elif args.command == 'check':
            commit = revision(args.ref)
            value = check_release(commit, args.branch)
            fetch(args.no_fetch)
            if args.tag and (args.tag != config(commit).get('tag_prefix', 'v') + value or revision('refs/tags/' + args.tag) != commit):
                raise ValueError('Published tag must match both the native version and the exact release commit')
            if args.tag:
                stable = 'refs/remotes/origin/master' if git('rev-parse', '--verify', 'refs/remotes/origin/master', check=False).returncode == 0 else 'master'
                if git('merge-base', '--is-ancestor', commit, revision(stable), check=False).returncode:
                    raise ValueError('A package tag must identify a reviewed commit in master history')
            available_version(commit, value)
            print('Release metadata is consistent: ' + value)
        else:
            commit = os.environ['CI_COMMIT_SHA']
            value = check_release(revision(commit))
            sys.path.insert(0, str(Path.cwd() / 'ci'))
            import release as backend_policy
            if Path(backend_policy.__file__).resolve() == Path(__file__).resolve():
                raise ValueError('This repository has no backend production release adapter')
            return backend_policy.main(approved_version=value)
    except (ValueError, RuntimeError, KeyError, OSError, TypeError) as error:
        print('Release operation failed: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
