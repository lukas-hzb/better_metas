import json
from pathlib import Path


PLONKIT_METAS_PATH = Path(__file__).parent.parent / "data" / "plonkit_metas.json"


def load_plonkit_metas():
    with open(PLONKIT_METAS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_plonkit_metas(data):
    with open(PLONKIT_METAS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=True)
