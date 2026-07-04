#!/usr/bin/env python3
"""
Generate scope values for all metas in plonkit_metas.json.

Scope indicates the geographic applicability of a meta:
- Countrywide: Feature applies anywhere in the country
- Region: Feature applies to a large region/state
- Longitude: Feature varies by longitude
- 1000km: Applies within ~1000km radius
- 100km: Applies within ~100km radius  
- 10km: Applies within ~10km radius
- 1km: Applies within ~1km radius
- Unique: One-of-a-kind location identifier
- (empty): Doesn't fit above categories (e.g., entire streets)
"""

import json
import re
from pathlib import Path

JSON_FILE_PATH = Path(__file__).parent.parent / "data" / "plonkit_metas.json"


def determine_scope(title: str, desc: str, note: str, section: str) -> str:
    """Determine the scope for a meta based on its content."""
    d = desc.lower()
    t = title.lower()
    n = note.lower() if note else ""
    all_text = f"{d} {t} {n}"
    
    # ============================================
    # UNIQUE - One-of-a-kind locations/landmarks
    # ============================================
    unique_patterns = [
        r"only found (at|in|near|around)\s+[A-Z]",
        r"unique to\s+[A-Z]",
        r"exclusively found",
        r"the only\s+(place|location|spot)",
        r"one of a kind",
        r"single\s+(bridge|building|landmark)",
    ]
    for pattern in unique_patterns:
        if re.search(pattern, desc, re.I):
            return "Unique"
    
    # Specific single landmarks/monuments
    if any(x in d for x in ["monument", "statue", "memorial", "landmark", "fortress", "castle", "palace"]):
        if "across the country" not in d and "throughout" not in d:
            return "Unique"
    
    # ============================================
    # COUNTRYWIDE - National-level features
    # ============================================
    countrywide_patterns = [
        # Driving side
        r"(drives?|driving)\s+on\s+the\s+(left|right)",
        r"(left|right)[-\s]hand\s+traffic",
        r"(left|right)\s+side\s+of\s+the\s+road",
        
        # License plates (national)
        r"(licence|license)\s+plate",
        r"plates?\s+(are|is)\s+(generally|typically|usually|commonly)",
        
        # Language (national)
        r"official\s+language",
        r"the\s+language\s+(is|in)",
        r"(alphabet|script)\s+(is|uses?)",
        
        # Currency
        r"(currency|money)\s+(is|in)",
        
        # National patterns
        r"(can\s+be\s+)?found\s+(throughout|across|all\s+over)\s+(the\s+)?country",
        r"(everywhere|anywhere)\s+in\s+\w+",
        r"in\s+all\s+(parts|regions|areas)\s+of",
        r"(common|typical|standard)\s+(throughout|across)\s+\w+",
        r"(generally|typically|usually)\s+use[sd]?\s+(yellow|white|blue|red|green)",
        r"all\s+(roads?|coverage)\s+in\s+\w+",
        r"\w+\s+(primarily|mainly|mostly)\s+uses?",
    ]
    
    for pattern in countrywide_patterns:
        if re.search(pattern, desc, re.I):
            return "Countrywide"
    
    # Specific countrywide features
    countrywide_keywords = [
        "licence plate", "license plate",
        "drives on the left", "drives on the right",
        "left-hand traffic", "right-hand traffic",
        "official language",
        "the coverage in",  # Usually describes all coverage
        "google car", "pickup truck", # Car meta is usually countrywide
    ]
    for kw in countrywide_keywords:
        if kw in d:
            # Check it's not region-specific
            if not any(x in d for x in ["north", "south", "east", "west", "region", "coast", "area"]):
                return "Countrywide"
    
    # Road line colors are usually countrywide
    if ("road" in d or "roads" in d) and ("yellow" in d or "white" in d) and "line" in d:
        if "outer" in d or "center" in d or "centre" in d or "middle" in d:
            return "Countrywide"
    
    # Step 1 items are often countrywide identifiers
    if section == "Step 1":
        # Features that distinguish the country
        if any(x in d for x in ["can be", "are used", "typically use", "primarily use", "generally"]):
            return "Countrywide"
    
    # ============================================
    # REGION - Large area within country
    # ============================================
    region_patterns = [
        # Cardinal direction regions
        r"(northern|southern|eastern|western|central)\s+(part|half|portion|region|area)",
        r"(the\s+)?(north|south|east|west)\s+of\s+the\s+country",
        r"in\s+the\s+(north|south|east|west)(ern)?",
        r"(north|south|east|west)\s+of\s+\w+",
        r"(coast|coastal)\s+(region|area)",
        r"panhandle",
        
        # Named regions
        r"region\s+of\s+\w+",
        r"\w+\s+region",
        r"\w+\s+province",
        r"\w+\s+state\b",
    ]
    
    for pattern in region_patterns:
        if re.search(pattern, desc, re.I):
            return "Region"
    
    # ============================================
    # LONGITUDE - Longitude-based features
    # ============================================
    if "longitude" in d or "meridian" in d:
        return "Longitude"
    
    # ============================================
    # 1000km - Very large areas
    # ============================================
    if re.search(r"(entire|whole)\s+(western|eastern|northern|southern)\s+half", d, re.I):
        return "1000km"
    
    # ============================================
    # 100km - Large cities, mountain ranges
    # ============================================
    # Large city areas
    if any(x in t.lower() for x in ["city", "capital"]):
        if "around" in d or "surrounding" in d or "region" in d:
            return "100km"
    
    # Mountain ranges visible from far
    if "mountain" in d and ("range" in d or "visible from" in d or "can be seen" in d):
        if "everywhere" not in d and "across" not in d:
            return "100km"
    
    # ============================================
    # 10km - Specific roads, town features
    # ============================================
    # Specific road stretches with endpoints
    road_patterns = [
        r"\b[A-Z]\d+\s+between\s+\w+\s+and\s+\w+",
        r"\b[A-Z]\d+\s+(north|south|east|west)\s+of\s+\w+",
        r"(road|highway)\s+\w+\s+between",
        r"section\s+of\s+(road|highway)?\s*[A-Z]?\d+",
        r"stretch\s+of\s+(road|highway)?\s*[A-Z]?\d+",
    ]
    for pattern in road_patterns:
        if re.search(pattern, desc, re.I):
            return "10km"
    
    # Town/city specific features
    town_patterns = [
        r"in\s+[A-Z][a-z]+\s+(you|the|there|most)",
        r"[A-Z][a-z]+\s+(is|has|can|features?)",
        r"around\s+[A-Z][a-z]+",
        r"the\s+town\s+of\s+[A-Z]",
        r"the\s+city\s+of\s+[A-Z]",
        r"from\s+[A-Z][a-z]+\s+(you|the)",
    ]
    for pattern in town_patterns:
        if re.search(pattern, desc):
            # Make sure it's about a specific place, not a general feature
            if any(x in d for x in ["recogni", "distinguish", "identify", "can be seen", "visible", "surround"]):
                return "10km"
    
    # Towns with specific features (from title)
    town_in_title = re.search(r"^([A-Z][a-z]+(?:[-\s][A-Z][a-z]+)?)\s", title)
    if town_in_title:
        town_name = town_in_title.group(1).lower()
        # Exclude generic words
        if town_name not in ["the", "a", "an", "road", "route", "highway", "blue", "red", "green", "yellow", "white", "black", "north", "south", "east", "west", "left", "right", "gen", "main", "limited", "desert", "coastal", "mountain", "flat"]:
            # Check if it's about a specific town
            if any(x in t.lower() for x in ["city", "town", "view", "grid", "hills", "ridge", "mountain", "feature"]):
                return "10km"
    
    # Specific road coverage areas
    if re.search(r"\b[ABCDEFM]\d+\b", desc) or re.search(r"road\s+[ABCDEFM]\d+", d):
        # Named roads with specific descriptions
        return "10km"
    
    # ============================================
    # 1km - Specific neighborhoods, small areas
    # ============================================
    km1_patterns = [
        r"(downtown|centre|center|cbd)\s+of",
        r"(part|neighborhood|district)\s+of\s+(the\s+)?(town|city)",
        r"(west|east|north|south)ern?\s+part\s+of\s+(the\s+)?(town|city)",
    ]
    for pattern in km1_patterns:
        if re.search(pattern, desc, re.I):
            return "1km"
    
    # ============================================
    # EMPTY - Features that don't fit categories
    # ============================================
    # Headers/section titles
    simple_headers = [
        "landscape", "roads", "infrastructure", "car meta", "towns",
        "important notes", "overview",
    ]
    for header in simple_headers:
        if d.strip() == header or t.strip() == header:
            return ""
    
    # Maps and coverage info (informational, no scope)
    if any(x in t.lower() for x in ["map", "header", "overview", "notes"]):
        return ""
    
    # Generic features without specific location
    if re.search(r"(along|throughout)\s+the\s+road", d, re.I):
        return ""
    
    # If the description mentions specific features but across too broad an area
    if "can be found" in d and len(d) < 100:
        return "Countrywide"
    
    # ============================================
    # FALLBACKS based on step/section
    # ============================================
    
    # Step 1 is usually country identification - default to Countrywide
    if section == "Step 1":
        return "Countrywide"
    
    # Step 2 is usually region narrowing
    if section == "Step 2":
        return "Region"
    
    # Step 3 is usually specific locations
    if section == "Step 3":
        return "10km"
    
    # Default: leave empty for unclear cases
    return ""


def main():
    print("Loading plonkit_metas.json...")
    with open(JSON_FILE_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    stats = {
        "Countrywide": 0,
        "Region": 0,
        "Longitude": 0,
        "1000km": 0,
        "100km": 0,
        "10km": 0,
        "1km": 0,
        "Unique": 0,
        "": 0,
    }
    
    count = 0
    for country_data in data:
        country_name = country_data.get('country', 'Unknown')
        for meta in country_data.get('metas', []):
            # Process all metas (to update any that might have been missed)
            title = meta.get('title', '')
            desc = meta.get('description', '')
            note = meta.get('note', '')
            section = meta.get('section', '')
            
            new_scope = determine_scope(title, desc, note, section)
            meta['scope'] = new_scope
            stats[new_scope] += 1
            count += 1
            
            # Show first few examples of each type
            if sum(1 for k, v in stats.items() if v <= 3 and k == new_scope) and new_scope:
                print(f"[{country_name}] {new_scope:12} | {title[:40]}")
    
    print(f"\n{'='*50}")
    print("SCOPE DISTRIBUTION:")
    print('='*50)
    for scope, num in sorted(stats.items(), key=lambda x: -x[1]):
        label = scope if scope else "(empty)"
        print(f"  {label:12}: {num:5} metas")
    print(f"{'='*50}")
    print(f"Total: {count} metas processed\n")
    
    print("Saving to plonkit_metas.json...")
    with open(JSON_FILE_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    
    print("Done!")


if __name__ == "__main__":
    main()
