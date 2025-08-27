package service

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
)

func Scan(image multipart.File) (*string, error) {
	url := "http://127.0.0.1:5000/ocr/thai-id/"

	var body bytes.Buffer
	w := multipart.NewWriter(&body)

	fw, err := w.CreateFormFile("file", "upload.jpg")
	if err != nil {
		return nil, err
	}
	if _, err = io.Copy(fw, image); err != nil {
		return nil, err
	}
	if err = w.Close(); err != nil { // finalize boundary
		return nil, err
	}

	req, err := http.NewRequest("POST", url, &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	res := string(b)
	return &res, nil
}
