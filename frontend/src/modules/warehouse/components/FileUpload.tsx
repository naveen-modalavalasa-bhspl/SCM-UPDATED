// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { Upload, Modal, message } from 'antd';
import { InboxOutlined, PlusOutlined } from '@ant-design/icons';
import api from '../config/api';

const { Dragger } = Upload;

const FileUpload = ({
  value = [],
  onChange,
  uploadUrl = '/attachments/upload',
  maxCount = 5,
  maxSize = 10,
  accept,
  listType = 'text',
  multiple = true,
  disabled = false,
  dragMode = true,
  hint,
}) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState('');
  const [previewTitle, setPreviewTitle] = useState('');
  const buildList = (vals) =>
    (vals || []).map((file, index) => ({
      uid: file.uid || file.id || `-${index}`,
      name: file.name || file.file_name || 'File',
      status: 'done',
      url: file.url || file.file_url,
      response: file,
    }));
  const [fileList, setFileList] = useState(buildList(value));

  // BUG-FE-152: parent updates to `value` (e.g. controlled forms) must
  // re-flow into local state. Compare a stable signature so we don't loop on
  // identical re-renders.
  useEffect(() => {
    const sig = JSON.stringify(
      (value || []).map((f) => f.id || f.uid || f.url || f.file_url || f.name)
    );
    const localSig = JSON.stringify(
      fileList.map((f) => f.response?.id || f.uid || f.url || f.name)
    );
    if (sig !== localSig) {
      setFileList(buildList(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const getBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result);
      reader.onerror = (error) => reject(error);
    });

  const handlePreview = async (file) => {
    if (!file.url && !file.preview) {
      file.preview = await getBase64(file.originFileObj);
    }
    setPreviewImage(file.url || file.preview);
    setPreviewOpen(true);
    setPreviewTitle(
      file.name || file.url.substring(file.url.lastIndexOf('/') + 1)
    );
  };

  const handleChange = ({ fileList: newFileList }) => {
    setFileList(newFileList);
    const doneFiles = newFileList
      .filter((f) => f.status === 'done')
      .map((f) => f.response || { name: f.name, url: f.url });
    if (onChange) {
      onChange(doneFiles);
    }
  };

  const beforeUpload = (file) => {
    const isWithinSize = file.size / 1024 / 1024 < maxSize;
    if (!isWithinSize) {
      message.error(`File must be smaller than ${maxSize}MB`);
      return Upload.LIST_IGNORE;
    }
    // BUG-FE-150: enforce the `accept` allowlist at the JS layer too — the
    // <input accept> attribute is only an OS-dialog hint and the user can
    // still drop disallowed files via Drag & Drop.
    if (accept) {
      const tokens = String(accept).split(',').map((t) => t.trim()).filter(Boolean);
      const fname = (file.name || '').toLowerCase();
      const ftype = (file.type || '').toLowerCase();
      const matches = tokens.some((tok) => {
        const t = tok.toLowerCase();
        if (!t) return false;
        if (t.startsWith('.')) return fname.endsWith(t);
        if (t.endsWith('/*')) return ftype.startsWith(t.slice(0, -1));
        return ftype === t;
      });
      if (!matches) {
        message.error(`File type not allowed. Accepted: ${accept}`);
        return Upload.LIST_IGNORE;
      }
    }
    return true;
  };

  // BUG-FE-154: simple concurrency cap so 50 files dragged in at once don't
  // saturate the upload endpoint. Each request waits its turn behind the cap.
  const MAX_CONCURRENT_UPLOADS = 3;
  const _uploadGate = React.useRef({ inFlight: 0, queue: [] });
  const _acquireSlot = () =>
    new Promise((resolve) => {
      const gate = _uploadGate.current;
      const tryStart = () => {
        if (gate.inFlight < MAX_CONCURRENT_UPLOADS) {
          gate.inFlight += 1;
          resolve();
        } else {
          gate.queue.push(tryStart);
        }
      };
      tryStart();
    });
  const _releaseSlot = () => {
    const gate = _uploadGate.current;
    gate.inFlight = Math.max(0, gate.inFlight - 1);
    const next = gate.queue.shift();
    if (next) next();
  };

  const customRequest = async ({ file, onSuccess, onError, onProgress }) => {
    const formData = new FormData();
    formData.append('file', file);

    await _acquireSlot();
    try {
      const response = await api.post(uploadUrl, formData, {
        onUploadProgress: (event) => {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress({ percent });
        },
      });
      onSuccess(response.data);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Upload error:', error);
      onError(error);
      message.error('Upload failed');
    } finally {
      _releaseSlot();
    }
  };

  const uploadProps = {
    fileList,
    onChange: handleChange,
    beforeUpload,
    customRequest,
    maxCount,
    multiple,
    accept,
    disabled,
    listType,
    onPreview: listType === 'picture-card' ? handlePreview : undefined,
  };

  if (dragMode && listType === 'text') {
    return (
      <div className="file-upload-wrapper">
        <Dragger {...uploadProps}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">
            Click or drag files to upload
          </p>
          <p className="ant-upload-hint">
            {hint ||
              `Max ${maxCount} files, each up to ${maxSize}MB. ${
                accept ? `Accepted: ${accept}` : ''
              }`}
          </p>
        </Dragger>
        <Modal
          open={previewOpen}
          title={previewTitle}
          footer={null}
          onCancel={() => setPreviewOpen(false)}
        >
          <img
            alt="Preview"
            style={{ width: '100%' }}
            src={previewImage}
          />
        </Modal>
      </div>
    );
  }

  return (
    <div className="file-upload-wrapper">
      <Upload {...uploadProps}>
        {fileList.length >= maxCount ? null : listType === 'picture-card' ? (
          <div>
            <PlusOutlined />
            <div style={{ marginTop: 8 }}>Upload</div>
          </div>
        ) : (
          <div>
            <InboxOutlined style={{ fontSize: 20, marginRight: 8 }} />
            Click to upload
          </div>
        )}
      </Upload>
      <Modal
        open={previewOpen}
        title={previewTitle}
        footer={null}
        onCancel={() => setPreviewOpen(false)}
      >
        <img alt="Preview" style={{ width: '100%' }} src={previewImage} />
      </Modal>
    </div>
  );
};

export default FileUpload;
