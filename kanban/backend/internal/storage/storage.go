package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Local struct {
	root     string
	maxBytes int64
}

type Stored struct {
	Key      string
	Filename string
	MIME     string
	Size     int64
	Checksum string
}

// Картинки и PDF показываем прямо в браузере, остальное отдаём файлом.
// SVG намеренно не в списке: внутри может быть скрипт.
var inlineTypes = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/gif": true,
	"image/webp": true, "application/pdf": true,
}

func NewLocal(root string, maxBytes int64) (*Local, error) {
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("создание каталога загрузок: %w", err)
	}
	return &Local{root: root, maxBytes: maxBytes}, nil
}

func (l *Local) Save(src io.Reader, originalName string) (*Stored, error) {
	name := sanitize(originalName)
	key := fmt.Sprintf("%s/%s%s",
		time.Now().UTC().Format("2006/01"),
		uuid.NewString(),
		strings.ToLower(filepath.Ext(name)))

	full := filepath.Join(l.root, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		return nil, err
	}

	dst, err := os.OpenFile(full, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return nil, err
	}
	defer dst.Close()

	head := make([]byte, 512)
	n, err := io.ReadFull(src, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		_ = os.Remove(full)
		return nil, err
	}
	head = head[:n]

	hasher := sha256.New()
	limited := io.LimitReader(io.MultiReader(bytes.NewReader(head), src), l.maxBytes+1)
	size, err := io.Copy(io.MultiWriter(dst, hasher), limited)
	if err != nil {
		_ = os.Remove(full)
		return nil, err
	}
	if size > l.maxBytes {
		_ = os.Remove(full)
		return nil, fmt.Errorf("файл больше допустимого размера")
	}

	detected := http.DetectContentType(head)
	if byExt := mime.TypeByExtension(filepath.Ext(name)); byExt != "" &&
		strings.HasPrefix(detected, "application/octet-stream") {
		detected = byExt
	}

	return &Stored{
		Key:      key,
		Filename: name,
		MIME:     detected,
		Size:     size,
		Checksum: hex.EncodeToString(hasher.Sum(nil)),
	}, nil
}

func (l *Local) Open(key string) (io.ReadSeekCloser, error) {
	clean := filepath.Clean(filepath.FromSlash(key))
	if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
		return nil, fmt.Errorf("недопустимый ключ файла")
	}
	return os.Open(filepath.Join(l.root, clean))
}

func (l *Local) Delete(key string) error {
	clean := filepath.Clean(filepath.FromSlash(key))
	if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
		return fmt.Errorf("недопустимый ключ файла")
	}
	err := os.Remove(filepath.Join(l.root, clean))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func Disposition(mimeType, filename string, forceDownload bool) string {
	kind := "attachment"
	if !forceDownload && inlineTypes[mimeType] {
		kind = "inline"
	}
	return mime.FormatMediaType(kind, map[string]string{"filename": filename})
}

func sanitize(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == '/' || r == 0x7f {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." {
		name = "файл"
	}
	if len(name) > 200 {
		name = name[:200]
	}
	return name
}

