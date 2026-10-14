"""Keep Windows venv launch paths usable outside a packaged setup host."""
from pathlib import Path
import sys

if sys.platform == 'win32':
    config = Path(sys.prefix) / 'pyvenv.cfg'
    executable = Path(sys._base_executable).resolve(strict=True)
    replacements = {'home': str(executable.parent), 'executable': str(executable)}
    lines = config.read_text(encoding='utf-8').splitlines()
    config.write_text('\n'.join(
        f'{key} = {replacements[key]}' if (key := line.partition('=')[0].strip()) in replacements else line
        for line in lines
    ) + '\n', encoding='utf-8')
