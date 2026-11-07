from pathlib import Path
import shutil, datetime, hashlib
source=Path('pilotdeck-mobile/upstream-official/ui/server')
target=Path('/home/Marc/PilotDeck-src/ui/server')
backup=Path('.pilotdeck/work/team-runtime-backups')/datetime.datetime.now().strftime('%Y%m%d-%H%M%S-finish')
# Surgical index patch preserves live-only usage route and other unrelated changes.
p=target/'index.js'; old=p.read_text(); new=old
if "import { getProjectParticipants }" not in new:
 new=new.replace('#!/usr/bin/env node\n', "#!/usr/bin/env node\nimport { getProjectParticipants } from './pilotdeck-bridge.js';\n",1)
 new=new.replace("type: 'session-status',\n                    sessionId,", "type: 'session-status',\n                    sessionId,\n                    projectParticipants: getProjectParticipants(sessionId),",1)
assert new != old and 'projectParticipants: getProjectParticipants(sessionId)' in new
backup.mkdir(parents=True);shutil.copy2(p,backup/'index.js');p.write_text(new)
print('Surgical server index update; backup:',backup)
