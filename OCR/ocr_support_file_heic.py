import cv2
import os
import pytesseract
from ultralytics import YOLO
import numpy as np
import json
import re
import shutil
import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException
from typing import Dict
from PIL import Image
import pillow_heif

# --- IMPORTANT TESSERACT NOTE ---
# pytesseract requires the Tesseract OCR engine to be installed on your system.
# On Debian/Ubuntu: sudo apt-get install tesseract-ocr tesseract-ocr-tha
# On macOS: brew install tesseract tesseract-lang
# On Windows: Download from the official Tesseract repository.
# You may also need to set the command path:
# pytesseract.pytesseract.tesseract_cmd = r'/path/to/your/tesseract'

# --- Initialize FastAPI App ---
app = FastAPI(
    title="Thai ID Card OCR API",
    description="An API that uses YOLO and Pytesseract to extract data from a Thai ID card.",
    version="1.2.0"
)

# --- Global Variables & Model Loading ---
# Load models once when the API starts to avoid reloading on every request.
print("Loading models...")
try:
    CARD_DETECTOR = YOLO("./OCR/dect_card.pt")
    TEXT_DETECTOR = YOLO("./OCR/detec_text_v5.pt")
    print("Models loaded successfully.")
except Exception as e:
    print(f"Error loading models: {e}")
    CARD_DETECTOR, TEXT_DETECTOR = None, None

# --- Helper Functions for OCR Pipeline ---

def save_plotted_image(results, output_path):
    """Saves the plotted detection results to a file."""
    plotted_img = results[0].plot()
    cv2.imwrite(output_path, plotted_img)
    print(f"Saved detection plot to {output_path}")

def crop_card(card_detector_model, image_path):
    """Detects the ID card and returns the cropped image and results."""
    img = cv2.imread(image_path)
    if img is None: return None, None

    # --- Convert image to grayscale ---
    gray_img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    img_for_detection = cv2.cvtColor(gray_img, cv2.COLOR_GRAY2BGR)
    # --- End of conversion ---

    results = card_detector_model(img_for_detection, conf=0.25)
    boxes_data = results[0].boxes
    if len(boxes_data) == 0: return None, results
    confidences = boxes_data.conf.cpu().numpy()
    best_box_index = np.argmax(confidences)
    best_box = boxes_data.xyxy.cpu().numpy().astype(int)[best_box_index]
    x1, y1, x2, y2 = best_box
    # Crop from the original color image (or grayscale if you prefer)
    y1, y2 = max(0, y1), min(img.shape[0], y2)
    x1, x2 = max(0, x1), min(img.shape[1], x2)
    cropped_card = img[y1:y2, x1:x2]
    return (cropped_card, results) if cropped_card.size > 0 else (None, results)

def detect_text_fields(text_detector_model, cropped_card_img):
    """Detects text fields, filters for the best detection per label, and returns results."""
    if cropped_card_img is None: return [], None
    results = text_detector_model(cropped_card_img, conf=0.25)
    boxes_data = results[0].boxes
    best_detections = {}
    for i in range(len(boxes_data)):
        box = boxes_data.xyxy[i].cpu().numpy().astype(int)
        class_id = int(boxes_data.cls[i].cpu().numpy())
        label = text_detector_model.names[class_id]
        confidence = float(boxes_data.conf[i].cpu().numpy())
        if label not in best_detections or confidence > best_detections[label]['confidence']:
            best_detections[label] = {'box': box, 'label': label, 'confidence': confidence}
    detections = sorted(list(best_detections.values()), key=lambda d: (d['box'][1], d['box'][0]))
    print(f"Found {len(boxes_data)} raw text fields, filtered down to {len(detections)} unique fields.")
    return detections, results

def read_text_from_fields(cropped_card_img, text_fields):
    """Uses pytesseract to read text from each detected field."""
    extracted_data = {}
    th_labels = ['prefix_name_th', 'first_name_th', 'last_name_th']
    en_labels = ['prefix_name_en', 'first_name_en', 'last_name_en']
    for field in text_fields:
        box, label = field['box'], field['label']
        text_region = cropped_card_img[box[1]:box[3], box[0]:box[2]]
        if text_region.size > 0:
            lang = 'tha' if label in th_labels else ('eng' if label in en_labels else 'tha+eng')
            config = '--psm 7'
            extracted_text = pytesseract.image_to_string(text_region, lang=lang, config=config).strip()
            if extracted_text:
                cleaned_text = re.sub(r'[\n\x0c]', '', extracted_text)
                print(f"  Label '{label}': Read text -> '{cleaned_text}'")
                extracted_data[label] = cleaned_text
    return extracted_data

def map_entities(raw_text_data):
    """Cleans and structures the raw OCR data."""
    entities = {}
    if 'id_card' in raw_text_data:
        entities['id_card'] = re.sub(r'[^\d\s]', '', raw_text_data['id_card']).strip()
    if 'en_name' in raw_text_data:
        parts = raw_text_data['en_name'].split()
        if len(parts) >= 3:
            entities.update({'en_prefix': parts[0], 'en_firstname': parts[1], 'en_lastname': " ".join(parts[2:])})
        else:
            entities['en_name_raw'] = raw_text_data['en_name']
    for label, text in raw_text_data.items():
        if label not in ['id_card', 'en_name']:
            entities[label] = text.strip()
    return entities

# --- Main OCR Pipeline Function ---

def run_ocr_pipeline(image_path: str, output_dir: str) -> Dict:
    """
    Runs the full OCR pipeline for a single image and returns structured data.
    """
    if not all([CARD_DETECTOR, TEXT_DETECTOR]):
        raise HTTPException(status_code=503, detail="Models are not loaded. API is unavailable.")

    base_filename = os.path.splitext(os.path.basename(image_path))[0]
    
    # Step 1: Detect and Crop Card
    cropped_card, card_results = crop_card(CARD_DETECTOR, image_path)
    if card_results:
        save_plotted_image(card_results, os.path.join(output_dir, f"{base_filename}_1_card_detection.jpg"))
    if cropped_card is None:
        raise HTTPException(status_code=400, detail="Could not detect an ID card in the image.")

    # Step 2: Detect Text Fields
    text_fields, text_results = detect_text_fields(TEXT_DETECTOR, cropped_card)
    if text_results:
        save_plotted_image(text_results, os.path.join(output_dir, f"{base_filename}_2_text_detections.jpg"))

    # Step 3: Read Text from Fields
    raw_text_data = read_text_from_fields(cropped_card, text_fields)
    
    # Step 4: Map Entities
    final_entities = map_entities(raw_text_data)
    
    # Save final JSON output for logging
    json_output_path = os.path.join(output_dir, f"{base_filename}_data.json")
    with open(json_output_path, 'w', encoding='utf-8') as f:
        json.dump(final_entities, f, ensure_ascii=False, indent=4)
        
    return final_entities

# --- API Endpoint ---

@app.post("/ocr/thai-id/", response_model=Dict)
async def process_thai_id(file: UploadFile = File(...)):
    """
    Accepts an image (JPEG, PNG, HEIC) of a Thai ID card, processes it, 
    and returns the extracted data as JSON.
    """
    temp_dir = "temp_uploads"
    output_dir = "output_logs"
    os.makedirs(temp_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)
    
    # Use a generic temp name to handle conversion
    temp_file_path = os.path.join(temp_dir, "temp_image.png") 
    original_upload_path = os.path.join(temp_dir, file.filename)

    try:
        # Save the uploaded file to read its content
        with open(original_upload_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        # --- HEIC Conversion Logic ---
        if file.filename.lower().endswith(('.heic', '.heif')):
            print(f"HEIC file detected. Converting {file.filename} to PNG...")
            heif_file = pillow_heif.read_heif(original_upload_path)
            image = Image.frombytes(
                heif_file.mode,
                heif_file.size,
                heif_file.data,
                "raw",
            )
            # Convert Pillow Image (RGB) to OpenCV format (BGR)
            image_np_rgb = np.array(image)
            image_np_bgr = cv2.cvtColor(image_np_rgb, cv2.COLOR_RGB2BGR)
            # Save the converted image to the path the pipeline will use
            cv2.imwrite(temp_file_path, image_np_bgr)
            print("Conversion successful.")
        else:
            # If not HEIC, just copy it to the expected temp path
            shutil.copy(original_upload_path, temp_file_path)

        # Run the OCR pipeline on the (possibly converted) image
        extracted_data = run_ocr_pipeline(temp_file_path, output_dir)
        
        return extracted_data

    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        raise HTTPException(status_code=500, detail=f"An internal server error occurred: {e}")
    finally:
        # Clean up both temporary files
        if os.path.exists(temp_file_path):
            os.remove(temp_file_path)
        if os.path.exists(original_upload_path):
            os.remove(original_upload_path)

# --- How to Run ---
# 1. Install necessary packages:
#    pip install fastapi "uvicorn[standard]" python-multipart pytesseract pillow-heif
#
# 2. Install the Tesseract engine on your system (see note at the top of the file).
#
# 3. Save this code as a Python file (e.g., `main.py`).
#
# 4. Run the API server from your terminal:
#    uvicorn main:app --reload
#
# 5. Access the interactive API documentation at http://127.0.0.1:5000/docs

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)
