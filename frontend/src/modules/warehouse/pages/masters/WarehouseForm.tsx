// @ts-nocheck
import React, { useState, useEffect } from 'react';
import {
  Card, Form, Input, Select, Space, Button, message, Row, Col, Spin,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const WAREHOUSE_TYPES = [
  { label: 'Main Warehouse', value: 'main' },
  { label: 'Distribution Center', value: 'distribution' },
  { label: 'Cold Storage', value: 'cold_storage' },
  { label: 'Transit', value: 'transit' },
  { label: 'Returns', value: 'returns' },
  { label: 'Quarantine', value: 'quarantine' },
];

const WarehouseForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [parentOptions, setParentOptions] = useState([]);

  const loadParents = async () => {
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 200 } });
      const items = res.data?.items || res.data?.data || res.data || [];
      const options = items
        .filter((w) => isNew || String(w.id) !== String(id))
        .map((w) => ({ label: w.name || w.warehouse_name, value: w.id }));
      setParentOptions(options);
    } catch (err) {
      console.error('Failed to load parent warehouses', err);
    }
  };

  const fetchWarehouse = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/masters/warehouses/${id}`);
      const data = res.data;
      form.setFieldsValue({
        ...data,
        status: data.is_active === false ? 'inactive' : 'active',
      });
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/masters/warehouses');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadParents();
    if (!isNew) {
      fetchWarehouse();
    } else {
      form.setFieldsValue({
        status: 'active',
      });
    }
  }, [id, isNew]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const { status, ...rest } = values;
      const payload = {
        ...rest,
        code: (values.code || '').trim(),
        name: (values.name || '').trim(),
        is_active: status === 'inactive' ? false : true,
      };

      setSubmitting(true);
      if (isNew) {
        await api.post('/masters/warehouses', payload);
        message.success('Warehouse created successfully');
      } else {
        await api.put(`/masters/warehouses/${id}`, payload);
        message.success('Warehouse updated successfully');
      }
      navigate('/masters/warehouses');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  return (
    <div>
      <PageHeader title={isNew ? 'Create Warehouse' : 'Edit Warehouse'} subtitle="Configure warehouse details and location hierarchy">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/masters/warehouses')}>Back to Warehouses</Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting}>
            {isNew ? 'Create' : 'Save'}
          </Button>
        </Space>
      </PageHeader>
      <Card>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="name" label="Warehouse Name" rules={[{ required: true, whitespace: true, message: 'Warehouse name is required' }]}>
                <Input placeholder="Enter name" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="code" label="Warehouse Code" rules={[{ required: true, whitespace: true, message: 'Warehouse code is required' }]}>
                <Input placeholder="e.g. WH-001" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="warehouse_type" label="Warehouse Type">
                <Select placeholder="Select type" options={WAREHOUSE_TYPES} allowClear />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="Status" initialValue="active">
                <Select
                  options={[
                    { label: 'Active', value: 'active' },
                    { label: 'Inactive', value: 'inactive' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                name="parent_id"
                label="Parent Warehouse"
                rules={[
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (value && id && String(value) === String(id)) {
                        return Promise.reject(new Error('A warehouse cannot be its own parent'));
                      }
                      return Promise.resolve();
                    },
                  }),
                ]}
              >
                <Select
                  placeholder="Select parent warehouse (optional)"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={[
                    { label: 'None (Top Level Warehouse)', value: null },
                    ...parentOptions,
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={2} placeholder="Warehouse address" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="city" label="City">
                <Input placeholder="City" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="state" label="State">
                <Input placeholder="State" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="pincode" label="Pincode">
                <Input placeholder="Pincode" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="contact_person" label="Contact Person">
                <Input placeholder="Contact person" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="contact_phone" label="Contact Phone">
                <Input placeholder="Phone" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Description" />
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default WarehouseForm;
