#!/usr/bin/env python3
"""
Generate AI-style titles for all empty entries.

This script analyzes each description and generates meaningful, 
concise titles following GeoGuessr meta conventions.
"""

import re

try:
    from .data_utils import load_plonkit_metas, save_plonkit_metas
except ImportError:
    from data_utils import load_plonkit_metas, save_plonkit_metas


def generate_title(desc: str, country: str) -> str:
    """Generate a meaningful title from description content."""
    d = desc.lower()
    
    # Header entries - simple section headers
    simple_headers = {
        "landscape and vegetation": "Landscape Header",
        "roads": "Roads Header", 
        "infrastructure": "Infrastructure Header",
        "car meta": "Car Meta Header",
        "towns": "Towns Header",
        "other recognizable towns": "Towns Header",
        "towns and cities with the southern mirror": "Southern Mirror Towns",
        "em-04": "EM-04 Road",
        "em-11": "EM-11 Road",
        "em-09": "EM-09 Road",
        "em-10": "EM-10 Road",
        "eo-01": "EO-01 Road",
        "eo-02": "EO-02 Road",
        "ev-01": "EV-01 Road",
        "important notes": "Road Notes",
    }
    
    for header, title in simple_headers.items():
        if d.strip() == header or d.startswith(header + "\n") or d.startswith(header + ":"):
            return title
    
    # Road sections with "Includes X tips"
    if "includes" in d and "tips" in d:
        road_match = re.search(r'\b(em-?\d+|eo-?\d+|ev-?\d+|a\d+|m\d+|e\d+|p\d+|r\d+)\b', d, re.I)
        if road_match:
            return f"{road_match.group(1).upper()} Overview"
        return "Road Overview"
    
    # License plates
    if "licence plate" in d or "license plate" in d:
        if "white" in d and "blue" in d:
            return "White-Blue Plates"
        if "yellow" in d:
            return "Yellow Plates"
        if "red" in d and ("strip" in d or "stripe" in d):
            return "Red Strip Plates"
        if "black" in d and "white" in d:
            return "Black-White Plates"
        if "code" in d:
            return "Plate Region Codes"
        return "License Plates"
    
    # Script/Language
    if "cyrillic" in d and "latin" in d:
        return "Dual Script Alphabet"
    if "cyrillic" in d:
        return "Cyrillic Script"
    if "devanagari" in d:
        return "Devanagari Script"
    if "arabic" in d and ("language" in d or "script" in d or "official" in d):
        return "Arabic Language"
    if "alphabet" in d or ("language" in d and len(d) < 200):
        return "Language Features"
    
    # Street view car/camera
    if "shitcam" in d:
        return "Shitcam Coverage"
    if "generation 2" in d or "gen 2" in d:
        return "Gen 2 Coverage"
    if "generation 3" in d or "gen 3" in d:
        return "Gen 3 Coverage"
    if "pickup" in d and "truck" in d:
        if "white" in d:
            return "White Pickup Meta"
        return "Pickup Truck Meta"
    if "wire" in d and ("back" in d or "car" in d or "visible" in d):
        return "Visible Wire Meta"
    if "dirty" in d and "roof" in d:
        return "Dirty Roof Meta"
    if "smudge" in d:
        if "zigzag" in d:
            return "Zigzag Smudge Meta"
        return "Roof Smudge Meta"
    if "dot" in d and ("roof" in d or "car" in d):
        return "Roof Dot Meta"
    if "coating" in d and "dirt" in d:
        return "Dusty Roof Meta"
    if "line of dirt" in d:
        return "Dirt Line Meta"
    
    # Crossings
    if "pedestrian crossing" in d or "crosswalk" in d or "crossing" in d and "stripe" in d:
        return "Striped Crosswalks"
    
    # Signs
    if "street sign" in d:
        if "blue" in d:
            return "Blue Street Signs"
        if "white" in d:
            return "White Street Signs"
        if "qr code" in d:
            return "QR Code Signs"
        return "Street Signs"
    if "qr code" in d:
        return "QR Code Signs"
    
    # Bollards
    if "bollard" in d:
        if "90" in desc or "angle" in d:
            return "Angled Bollards"
        if "black" in d and "white" in d:
            return "Striped Bollards"
        return "Road Bollards"
    
    # Chevrons
    if "chevron" in d:
        if "yellow" in d and "black" in d:
            return "Yellow-Black Chevrons"
        if "red" in d and "white" in d:
            return "Red-White Chevrons"
        return "Road Chevrons"
    
    # Trees
    if "tree trunk" in d or ("tree" in d and "painted" in d and "white" in d):
        return "White-Painted Trees"
    if "birch forest" in d or "birch" in d:
        return "Birch Forests"
    if "pine forest" in d or "pine tree" in d or "baltic pine" in d:
        return "Pine Forests"
    if "spruce" in d:
        return "Spruce Forests"
    
    # Gas/pipes
    if "gas pipe" in d:
        if "yellow box" in d:
            return "Yellow Gas Boxes"
        return "Urban Gas Pipes"
    
    # Ornamental
    if "koshkar-muiz" in d:
        return "Koshkar-Muiz Pattern"
    if "entrance arc" in d:
        return "Town Entrance Arcs"
    
    # Coverage/maps
    if "coverage" in d and "limited" in d:
        return "Limited Coverage Map"
    if "coverage" in d and "season" in d:
        return "Seasonal Coverage"
    if "driving direction" in d:
        return "Driving Directions"
    if "area code" in d:
        return "Area Code Map"
    
    # Terrain/Landscape
    if "steppe" in d:
        if "grassy" in d or "green" in d:
            return "Green Steppes"
        if "dry" in d:
            return "Dry Steppes" 
        return "Steppe Landscape"
    if "desert" in d:
        if "sandy" in d:
            return "Sandy Desert"
        return "Desert Landscape"
    if "mountain" in d:
        if "snow" in d or "snow-capped" in d:
            return "Snow-Capped Mountains"
        if "tall" in d:
            return "Tall Mountains"
        if "hazy" in d:
            return "Hazy Mountains"
        if "tian shan" in d:
            return "Tian Shan Range"
        return "Mountain Terrain"
    if "rolling hill" in d:
        return "Rolling Hills"
    if "hilly" in d and "forested" in d:
        return "Forested Hills"
    if "hilly" in d:
        if "dry" in d:
            return "Dry Hills"
        return "Hilly Terrain"
    if "flat" in d and ("agricultural" in d or "agriculture" in d):
        return "Flat Agricultural Land"
    if "flat" in d and "empty" in d:
        return "Open Flat Landscape"
    if "grassy" in d and "plain" in d:
        return "Grassy Plains"
    if "fall colour" in d or "fall color" in d or "autumn" in d:
        return "Fall Colors"
    if "snow coverage" in d or ("snow" in d and "coverage" in d):
        return "Snow Coverage"
    if "forest fire" in d or "hazy" in d and "fire" in d:
        return "Forest Fire Haze"
    
    # Roads by name
    road_match = re.search(r'\b(e-?\d+|m-?\d+|a-?\d+|p-?\d+|r-?\d+|em-?\d+|eo-?\d+)\b', d, re.I)
    if road_match:
        road = road_match.group(1).upper().replace("-", "")
        if "divided" in d:
            return f"{road} Divided Highway"
        if "construction" in d or "under construction" in d:
            return f"{road} Construction"
        if "bad" in d or "poor" in d:
            return f"{road} Poor Road"
        if "unpaved" in d:
            return f"{road} Unpaved"
        return f"{road} Road Features"
    
    # Infrastructure
    if "pole paint" in d or ("pole" in d and "paint" in d):
        return "Painted Poles"
    if "bus stop" in d:
        return "Bus Stop Designs"
    if ("bus" in d or "buses" in d) and not "bus stop" in d:
        return "Regional Buses"
    if "lamp post" in d or "lamp" in d:
        if "blue" in d and "photocell" in d:
            return "Blue Photocell Lamps"
        if "ascending" in d or "3 separate" in d:
            return "Triple Lamp Design"
        if "grey" in d or "thin" in d:
            return "Grey Street Lamps"
        return "Street Lamps"
    
    # Towns/cities
    if "capital" in d:
        return "Capital City Features"
    if re.search(r'\b(city|town)\b.*\brecogni', d):
        # Extract city name
        city_match = re.search(r'\b([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\b', desc)
        if city_match and city_match.group(1).lower() not in ['the', 'you', 'this', 'that']:
            return f"{city_match.group(1)} City"
        return "City Features"
    
    # Reservoirs/lakes
    if "reservoir" in d:
        return "Reservoir Views"
    if "lake" in d:
        if "issyk" in d:
            return "Issyk Kul Lake"
        return "Lake Views"
    
    # Valley/gorge
    if "gorge" in d or "canyon" in d:
        return "River Gorge"
    if "valley" in d:
        return "Valley Landscape"
    
    # Weather/conditions
    if "sunset" in d:
        return "Sunset Coverage"
    if "overcast" in d and len(d) < 150:
        return "Overcast Coverage"
    if "sunny" in d and len(d) < 100:
        return "Sunny Coverage"
    if "snowy" in d and "town" in d:
        return "Snowy Town"
    
    # National parks
    if "national park" in d:
        park_match = re.search(r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+national\s+park', desc, re.I)
        if park_match:
            return f"{park_match.group(1)} Park"
        return "National Park"
    
    # Universities
    if "universit" in d:
        return "University Campus"
    
    # Bridges
    if "bridge" in d:
        bridge_match = re.search(r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+bridge', desc, re.I)
        if bridge_match:
            return f"{bridge_match.group(1)} Bridge"
        return "Bridge Features"
    
    # Mediterranean
    if "mediterranean" in d:
        return "Mediterranean Landscape"
    
    # Casinos/gambling
    if "casino" in d or "gambling" in d:
        return "Casino District"
    
    # Portuguese/colonial
    if "portuguese" in d:
        return "Portuguese Influence"
    
    # Architecture
    if "architecture" in d or "building" in d and "stone" in d:
        return "Local Architecture"
    if "sandstone" in d:
        return "Sandstone Buildings"
    
    # Poles
    if "pole" in d:
        if "concrete" in d:
            return "Concrete Poles"
        if "wooden" in d:
            return "Wooden Poles"
        if "metallic" in d or "metal" in d:
            return "Metal Poles"
        return "Utility Poles"
    
    # Road lines
    if "road line" in d or "road marking" in d:
        if "yellow" in d:
            return "Yellow Road Lines"
        if "white" in d:
            return "White Road Lines"
        return "Road Markings"
    
    # Vegetation
    if "vegetation" in d and "lot of" in d:
        return "Dense Vegetation"
    if "agricultural" in d or "agriculture" in d:
        return "Agricultural Area"
    
    # Coastal
    if "coastal" in d or "coast" in d or "ocean" in d:
        return "Coastal Coverage"
    if "promenade" in d:
        return "Coastal Promenade"
    
    # Median types
    if "median" in d:
        if "grassy" in d:
            return "Grassy Median"
        if "concrete" in d:
            return "Concrete Barriers"
        return "Road Median"
    
    # Ancient/historical
    if "ancient" in d or "historical" in d or "ruins" in d:
        return "Historical Site"
    if "fortress" in d:
        return "Historic Fortress"
    
    # Guardrails  
    if "guardrail" in d:
        if "red" in d:
            return "Red Guardrails"
        return "Road Guardrails"
    
    # Town-specific markers
    city_patterns = [
        r"in\s+([A-Z][a-z]+(?:-[A-Z][a-z]+)?)",
        r"([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s+is\s+",
        r"around\s+([A-Z][a-z]+(?:-[A-Z][a-z]+)?)",
    ]
    
    for pattern in city_patterns:
        match = re.search(pattern, desc)
        if match:
            city = match.group(1)
            if city.lower() not in ['the', 'you', 'this', 'all', 'some', 'most', 'here', 'there', 'when', 'like']:
                if "lamp" in d or "pole" in d:
                    return f"{city} Poles"
                if "ridge" in d or "hill" in d:
                    return f"{city} Hills"
                if "mountain" in d:
                    return f"{city} Mountains"
                if len(d) < 200:
                    return f"{city} Features"
    
    # Left side driving
    if "left side" in d and "road" in d:
        return "Left-Hand Traffic"
    if "right side" in d and "road" in d:
        return "Right-Hand Traffic"
    
    # Diverse landscape
    if "diverse" in d and ("landscape" in d or "country" in d):
        return "Diverse Landscapes"
    
    # Similar to other country
    if "similar to" in d:
        if "russia" in d:
            return "Russian Similarities"
        if "india" in d:
            return "Indian Similarities"
        if "turkey" in d or "turkish" in d:
            return "Turkish Similarities"
    
    # Generic fallbacks
    if "only" in d and country in d:
        return "Unique Feature"
    
    # Extract first meaningful phrase for very generic entries
    words = desc.split()
    if len(words) >= 3:
        # Take up to 4 meaningful words
        meaningful = []
        for w in words[:6]:
            w_clean = re.sub(r'[^\w\s-]', '', w)
            if w_clean and w_clean.lower() not in ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'been', 'can', 'you', 'will', 'this', 'that', 'these', 'those', 'in', 'on', 'at', 'to', 'of', 'for']:
                meaningful.append(w_clean.capitalize())
                if len(meaningful) >= 3:
                    break
        if meaningful:
            return ' '.join(meaningful)
    
    return "Regional Feature"


def main():
    print("Loading plonkit_metas.json...")
    data = load_plonkit_metas()
    
    count = 0
    for country_data in data:
        country_name = country_data.get('country', 'Unknown')
        for meta in country_data.get('metas', []):
            if meta.get('title', '') == '':
                desc = meta.get('description', '')
                if desc:
                    new_title = generate_title(desc, country_name)
                    meta['title'] = new_title
                    count += 1
                    if count <= 100:
                        print(f"[{country_name}] {new_title}")
                        print(f"  → {desc[:70]}...")
    
    print(f"\nGenerated {count} titles")
    
    print("Saving to plonkit_metas.json...")
    save_plonkit_metas(data)
    
    print("Done!")


if __name__ == "__main__":
    main()
