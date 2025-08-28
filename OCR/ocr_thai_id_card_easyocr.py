import cv2
import os
import easyocr
from ultralytics import YOLO
import numpy as np
import json
import re
import shutil
import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException
from typing import Dict

# --- Initialize FastAPI App ---
app = FastAPI(
    title="Thai ID Card OCR API",
    description="An API that uses YOLO and EasyOCR to extract data from a Thai ID card.",
    version="1.0.0"
)

# --- Global Variables & Model Loading ---
# Load models and readers once when the API starts to avoid reloading on every request.
print("Loading models and OCR readers...")
try:
    CARD_DETECTOR = YOLO("/Users/narudonsaehan/Downloads/ocr-poc/backend/python/dect_card.pt")
    TEXT_DETECTOR = YOLO("/Users/narudonsaehan/Downloads/ocr-poc/backend/python/detec_text_v5.pt")
    TH_READER = easyocr.Reader(['th'])
    EN_READER = easyocr.Reader(['en'])
    MIXED_READER = easyocr.Reader(['th', 'en'])
    print("Models and readers loaded successfully.")
except Exception as e:
    print(f"Error loading models or readers: {e}")
    CARD_DETECTOR, TEXT_DETECTOR, TH_READER, EN_READER, MIXED_READER = None, None, None, None, None

def save_plotted_image(results, output_path):
    """Saves the plotted detection results to a file."""
    plotted_img = results[0].plot()
    cv2.imwrite(output_path, plotted_img)
    print(f"Saved detection plot to {output_path}")

def crop_card(card_detector_model, image_path):
    """Detects the ID card and returns the cropped image and results."""
    img = cv2.imread(image_path)
    if img is None: return None, None

    # --- NEW: Convert image to grayscale ---
    # This can help improve detection robustness by removing color noise.
    # The image is converted to grayscale, then back to a 3-channel BGR image
    # so it's compatible with the YOLO model's input requirements.
    gray_img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    img = cv2.cvtColor(gray_img, cv2.COLOR_GRAY2BGR)
    # --- End of new code ---

    results = card_detector_model(img, conf=0.25, iou=0.25) # Pass the modified image to the model
    boxes_data = results[0].boxes
    if len(boxes_data) == 0: return None, results
    confidences = boxes_data.conf.cpu().numpy()
    best_box_index = np.argmax(confidences)
    best_box = boxes_data.xyxy.cpu().numpy().astype(int)[best_box_index]
    x1, y1, x2, y2 = best_box
    y1, y2 = max(0, y1), min(img.shape[0], y2)
    x1, x2 = max(0, x1), min(img.shape[1], x2)
    cropped_card = img[y1:y2, x1:x2]
    return (cropped_card, results) if cropped_card.size > 0 else (None, results)

def detect_text_fields(text_detector_model, cropped_card_img):
    """Detects text fields, filters for the best detection per label, and returns results."""
    if cropped_card_img is None: return [], None
    results = text_detector_model(cropped_card_img, iou=0.25, conf=0.01)
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

def read_text_from_fields(th_reader, en_reader, mixed_reader, cropped_card_img, text_fields):
    """Uses the appropriate OCR reader for each field."""
    extracted_data = {}
    th_labels = ['prefix_name_th', 'first_name_th', 'last_name_th', 'date_of_birth_th', 'date_of_expity_th', 'religion']
    en_labels = ['prefix_name_en', 'first_name_en', 'last_name_en', 'date_of_birth_en', 'date_of_expity_en']
    for field in text_fields:
        box, label = field['box'], field['label']
        text_region = cropped_card_img[box[1]:box[3], box[0]:box[2]]
        if text_region.size > 0:
            reader = th_reader if label in th_labels else (en_reader if label in en_labels else mixed_reader)
            result = reader.readtext(text_region, detail=0, paragraph=False)
            if result:
                extracted_data[label] = " ".join(result)
    return extracted_data

def map_entities(raw_text_data):
    """Cleans and structures the raw OCR data."""
    return raw_text_data

# --- Main OCR Pipeline Function ---

def run_ocr_pipeline(image_path: str, output_dir: str) -> Dict:
    """
    Runs the full OCR pipeline for a single image and returns structured data.
    """
    if not all([CARD_DETECTOR, TEXT_DETECTOR, TH_READER, EN_READER, MIXED_READER]):
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
    raw_text_data = read_text_from_fields(TH_READER, EN_READER, MIXED_READER, cropped_card, text_fields)
    
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
    Accepts an image of a Thai ID card, processes it, and returns the extracted data as JSON.
    """
    # Create temporary directories for processing
    temp_dir = "temp_uploads"
    output_dir = "output_logs"
    os.makedirs(temp_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)
    
    temp_file_path = os.path.join(temp_dir, file.filename)

    try:
        # Save the uploaded file temporarily
        with open(temp_file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        # Run the OCR pipeline
        extracted_data = run_ocr_pipeline(temp_file_path, output_dir)
        
        return extracted_data

    except HTTPException as e:
        # Re-raise HTTP exceptions to be handled by FastAPI
        raise e
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        raise HTTPException(status_code=500, detail=f"An internal server error occurred: {e}")
    finally:
        # Clean up the temporary file
        if os.path.exists(temp_file_path):
            os.remove(temp_file_path)

# --- How to Run ---
# 1. Install necessary packages:
#    pip install fastapi "uvicorn[standard]" python-multipart
#
# 2. Save this code as a Python file (e.g., `main.py`).
#
# 3. Run the API server from your terminal:
#    uvicorn main:app --reload
#
# 4. Access the interactive API documentation at http://127.0.0.1:8000/docs

if __name__ == "__main__":
    # This allows you to run the server by executing `python main.py`
    # Note: For production, it's better to use the uvicorn command directly.
    uvicorn.run(app, host="0.0.0.0", port=5000)
