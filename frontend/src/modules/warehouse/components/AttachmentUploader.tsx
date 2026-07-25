// @ts-nocheck
/**
 * Reusable attachment widget. Drop into any form that needs
 * supporting documents (Indent, MR, PO, GRN, Issue, Consumption…).
 *
 * Usage:
 *   <AttachmentUploader entityType="material_request" entityId={mr.id} />
 *
 * If `entityId` is null (the parent doc isn't saved yet), it stages the files
 * and exposes them via the `onChange` callback for the parent to upload after
 * the doc is created. Pass `staged` + `setStaged` to control state externally.
 *
 * Bug fix BUG_0092 — MR / PO forms were missing the attachment field entirely
 * even though the backend asks for them.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Upload, Button, List, Tag, Popconfirm, message, Space } from 'antd';
import {
  UploadOutlined, DeleteOutlined, FileTextOutlined,
  FileImageOutlined, PaperClipOutlined,
} from '@ant-design/icons';
import api from '../config/api';

const iconFor = (name = '') => {
  const ext = name.split('.').pop()?.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return <FileImageOutlined />;
  if (['pdf', 'doc', 'docx'].includes(ext)) return <FileTextOutlined />;
  return <PaperClipOutlined />;
};

export default function AttachmentUploader({
  entityType,
  entityId,
  staged: externalStaged,
  setStaged: externalSetStaged,
  onChange,
  required = false,
  label = 'Supporting Documents',
}) {
  const [internalStaged, setInternalStaged] = useState([]);
  const [existing, setExisting] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  const staged = externalStaged ?? internalStaged;
  const setStaged = externalSetStaged ?? setInternalStaged;

  const loadExisting = useCallback(async () => {
    if (!entityId) {
      setExisting([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get('/attachments', {
        params: { entity_type: entityType, entity_id: entityId },
      });
      const rows = Array.isArray(res.data) ? res.data : (res.data?.results || res.data?.items || []);
      setExisting(rows);
    } catch (e) {
      // empty list on error — don't block the form
      setExisting([]);
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => { loadExisting(); }, [loadExisting]);

  // Notify parent whenever staged changes
  useEffect(() => {
    if (onChange) onChange(staged, existing);
  }, [staged, existing, onChange]);

  const beforeUpload = (file) => {
    if (entityId) {
      // We have a saved entity — upload immediately
      doUpload(file);
    } else {
      // Stage for later — parent will call uploadStaged() after creating the doc
      setStaged((prev) => [...prev, file]);
    }
    return false; // prevent antd auto-upload
  };

  const doUpload = async (file) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entity_type', entityType);
      fd.append('entity_id', String(entityId));
      await api.post('/attachments/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      message.success(`${file.name} uploaded`);
      loadExisting();
    } catch (e) {
      message.error('Upload failed: ' + (e?.response?.data?.detail || e?.message || ''));
    } finally {
      setUploading(false);
    }
  };

  const removeStaged = (idx) => setStaged((prev) => prev.filter((_, i) => i !== idx));

  const removeExisting = async (id) => {
    try {
      await api.delete(`/attachments/${id}`);
      message.success('Removed');
      loadExisting();
    } catch (e) {
      message.error('Failed to remove: ' + (e?.response?.data?.detail || e?.message || ''));
    }
  };

  const total = staged.length + existing.length;

  return (
    <div>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space>
          <Upload beforeUpload={beforeUpload} showUploadList={false} multiple>
            <Button icon={<UploadOutlined />} loading={uploading}>
              {total === 0 ? `Add ${label}` : `Add Another`}
            </Button>
          </Upload>
          {required && total === 0 && <Tag color="orange">Attachment required</Tag>}
          {total > 0 && <Tag color="blue">{total} file{total > 1 ? 's' : ''}</Tag>}
        </Space>

        {existing.length > 0 && (
          <List
            size="small"
            bordered
            dataSource={existing}
            loading={loading}
            renderItem={(att) => (
              <List.Item
                actions={[
                  <a key="d" href={att.file_path || att.url} target="_blank" rel="noreferrer">Open</a>,
                  <Popconfirm key="r" title="Remove?" onConfirm={() => removeExisting(att.id)}>
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>,
                ]}
              >
                <Space>{iconFor(att.file_name)} {att.file_name} <Tag>{Math.round((att.file_size || 0) / 1024)} KB</Tag></Space>
              </List.Item>
            )}
          />
        )}

        {staged.length > 0 && (
          <List
            size="small"
            bordered
            header={<span style={{ color: '#888' }}>Will upload after save</span>}
            dataSource={staged.map((f, i) => ({ f, i }))}
            renderItem={({ f, i }) => (
              <List.Item
                actions={[
                  <Button key="r" size="small" danger icon={<DeleteOutlined />} onClick={() => removeStaged(i)} />,
                ]}
              >
                <Space>{iconFor(f.name)} {f.name} <Tag color="orange">staged</Tag></Space>
              </List.Item>
            )}
          />
        )}
      </Space>
    </div>
  );
}

/**
 * Helper for parent forms: after creating the entity (got an id), call this to
 * upload any staged files. Returns true on success, false otherwise.
 */
export async function uploadStagedAttachments(entityType, entityId, staged) {
  if (!staged || staged.length === 0) return true;
  for (const file of staged) {
    const fd = new FormData();
    fd.append('file', file.originFileObj || file);
    fd.append('entity_type', entityType);
    fd.append('entity_id', String(entityId));
    try {
      await api.post('/attachments/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    } catch (e) {
      message.error(`Failed to upload ${file.name}: ${e?.response?.data?.detail || e?.message || ''}`);
      return false;
    }
  }
  return true;
}
